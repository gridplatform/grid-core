import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { config } from '../config';

/**
 * Module bank (grid-terraform) checkout — same idea as desired-state GitOps:
 * clone once onto local disk / PVC, use that path for generate introspection,
 * refresh on Sync / auto-sync to the **admin-selected version**.
 *
 * Generated HCL uses the same version in `git::…?ref=<version>`.
 */

function isGitRemote(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^git::/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^git@[^:]+:/.test(v)) return true;
  return false;
}

function normalizeRemoteUrl(raw: string): string {
  return raw.trim().replace(/^git::/i, '');
}

function runGit(
  args: string[],
  cwd?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const STATUS_FILE = () => path.join(config.dataDir, 'module-bank-status.json');
const SETTINGS_FILE = () => path.join(config.dataDir, 'module-bank-settings.json');

export type ModuleBankSyncStatus = 'idle' | 'syncing' | 'ok' | 'error' | 'local';

export interface ModuleBankSettings {
  /** Active module bank version (git tag, branch, or commit). */
  version: string;
  /** Auto-sync interval in seconds. 0 = manual Sync only. Default 20. */
  syncIntervalSec: number;
  updatedAt?: string;
}

export interface ModuleBankStatus {
  /** Configured source (URL or local path). */
  source: string;
  /** True when GRID_MODULE_BANK is a git remote. */
  remote: boolean;
  /** Active version (admin-selected); used for Sync + git:: ?ref= */
  version: string;
  /** @deprecated alias of version — kept for older UI */
  ref: string;
  syncIntervalSec: number;
  /** Local path used for generate introspection. */
  localPath: string;
  syncStatus: ModuleBankSyncStatus;
  /** True while a sync is in flight (auto-cut: another sync will not start). */
  syncInProgress?: boolean;
  lastSyncAt?: string;
  lastSyncError?: string;
  lastCommit?: string;
  lastCommitMessage?: string;
  /** Available tags/versions from the remote (best-effort). */
  availableVersions?: string[];
}

let syncInFlight: Promise<ModuleBankStatus> | null = null;
let settingsCache: ModuleBankSettings | null = null;
let stopAutoSync: (() => void) | null = null;
let versionsCache: { at: number; versions: string[] } | null = null;

/** Durable checkout directory for a remote module bank (VM disk / K8s PVC). */
export function moduleBankCheckoutDir(): string {
  if (process.env.GRID_MODULE_BANK_CACHE) {
    return path.resolve(process.env.GRID_MODULE_BANK_CACHE);
  }
  return path.join(config.dataDir, 'module-bank');
}

export function moduleBankIsRemote(): boolean {
  return isGitRemote(String(config.moduleBank || ''));
}

/**
 * Local checkout path for a remote bank (or resolved local bank path).
 * Core Sync manages this tree; CLI uses it via GRID_MODULE_BANK_CACHE for
 * introspection while GRID_MODULE_BANK keeps the public git URL for git:: sources.
 */
export function moduleBankLocalPath(): string {
  if (moduleBankIsRemote()) return moduleBankCheckoutDir();
  return path.resolve(String(config.moduleBank));
}

function defaultSettings(): ModuleBankSettings {
  const envInterval = process.env.GRID_MODULE_BANK_SYNC_INTERVAL_SEC;
  const syncIntervalSec =
    envInterval !== undefined && envInterval !== ''
      ? Number(envInterval)
      : 20; // keep bank fresh without hammering git; admin can change
  return {
    version: config.moduleBankRef || 'main',
    syncIntervalSec: Number.isFinite(syncIntervalSec) ? Math.max(0, syncIntervalSec) : 20,
  };
}

/** True while a sync (manual or auto) is in progress — second sync joins/awaits the same run. */
export function isModuleBankSyncRunning(): boolean {
  return syncInFlight !== null;
}

async function readSettingsFile(): Promise<Partial<ModuleBankSettings>> {
  try {
    if (await fs.pathExists(SETTINGS_FILE())) {
      return (await fs.readJSON(SETTINGS_FILE())) as Partial<ModuleBankSettings>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** Load settings (cached). Call on boot and after updates. */
export async function loadModuleBankSettings(): Promise<ModuleBankSettings> {
  const saved = await readSettingsFile();
  const base = defaultSettings();
  // Prefer a release tag from .env over a stale saved `main` from earlier lab runs.
  const savedVer = (saved.version || '').trim();
  const baseVer = (base.version || '').trim();
  const releaseTag = /^v\d+\.\d+\.\d+(-[\w.]+)?$/i;
  let version = savedVer || baseVer || 'main';
  if (!releaseTag.test(savedVer) && releaseTag.test(baseVer)) {
    version = baseVer;
  }
  const next: ModuleBankSettings = {
    version,
    syncIntervalSec:
      typeof saved.syncIntervalSec === 'number' && Number.isFinite(saved.syncIntervalSec)
        ? Math.max(0, saved.syncIntervalSec)
        : base.syncIntervalSec,
    updatedAt: saved.updatedAt,
  };
  settingsCache = next;
  return next;
}

/** Sync getter for CLI env injection. */
export function getActiveModuleBankVersion(): string {
  return settingsCache?.version || config.moduleBankRef || 'main';
}

export function getModuleBankSyncIntervalSec(): number {
  if (settingsCache) return settingsCache.syncIntervalSec;
  return defaultSettings().syncIntervalSec;
}

export async function saveModuleBankSettings(
  patch: Partial<Pick<ModuleBankSettings, 'version' | 'syncIntervalSec'>>
): Promise<ModuleBankSettings> {
  const current = await loadModuleBankSettings();
  const next: ModuleBankSettings = {
    version:
      patch.version !== undefined
        ? String(patch.version).trim() || current.version
        : current.version,
    syncIntervalSec:
      patch.syncIntervalSec !== undefined
        ? Math.max(0, Number(patch.syncIntervalSec) || 0)
        : current.syncIntervalSec,
    updatedAt: new Date().toISOString(),
  };
  await fs.ensureDir(config.dataDir);
  await fs.writeJSON(SETTINGS_FILE(), next, { spaces: 2 });
  settingsCache = next;
  restartModuleBankAutoSync();
  return next;
}

async function readStatusFile(): Promise<Partial<ModuleBankStatus>> {
  try {
    if (await fs.pathExists(STATUS_FILE())) {
      return (await fs.readJSON(STATUS_FILE())) as Partial<ModuleBankStatus>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

async function writeStatus(patch: Partial<ModuleBankStatus>): Promise<ModuleBankStatus> {
  const current = await getModuleBankStatus({ includeVersions: false });
  const next: ModuleBankStatus = { ...current, ...patch };
  await fs.ensureDir(config.dataDir);
  await fs.writeJSON(STATUS_FILE(), next, { spaces: 2 });
  return next;
}

async function readHead(cwd: string): Promise<{ commit?: string; message?: string }> {
  const head = await runGit(['rev-parse', 'HEAD'], cwd);
  const msg = await runGit(['log', '-1', '--pretty=%s'], cwd);
  return {
    commit: head.code === 0 ? head.stdout.trim() : undefined,
    message: msg.code === 0 ? msg.stdout.trim() : undefined,
  };
}

/** List version tags (and common branches) from the module bank remote. */
export async function listModuleBankVersions(force = false): Promise<string[]> {
  if (!moduleBankIsRemote()) return [];
  const now = Date.now();
  if (!force && versionsCache && now - versionsCache.at < 30_000) {
    return versionsCache.versions;
  }

  const url = normalizeRemoteUrl(String(config.moduleBank));
  const tags = await runGit(['ls-remote', '--tags', '--refs', url]);
  const versions = new Set<string>();

  if (tags.code === 0) {
    for (const line of tags.stdout.split('\n')) {
      const m = line.trim().match(/\trefs\/tags\/(.+)$/);
      if (m?.[1]) versions.add(m[1]);
    }
  }

  // Always offer common moving refs + current active version.
  versions.add('main');
  versions.add(getActiveModuleBankVersion());

  const sorted = [...versions].sort((a, b) => {
    // Prefer semver-like tags first (v0.1.0), then alpha.
    const semver = (s: string) => {
      const m = s.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
    };
    const sa = semver(a);
    const sb = semver(b);
    if (sa && sb) {
      for (let i = 0; i < 3; i++) {
        if (sa[i] !== sb[i]) return sb[i] - sa[i];
      }
      return 0;
    }
    if (sa) return -1;
    if (sb) return 1;
    return a.localeCompare(b);
  });

  versionsCache = { at: now, versions: sorted };
  return sorted;
}

export async function getModuleBankStatus(opts?: {
  includeVersions?: boolean;
}): Promise<ModuleBankStatus> {
  await loadModuleBankSettings();
  const source = String(config.moduleBank || '');
  const remote = moduleBankIsRemote();
  const localPath = moduleBankLocalPath();
  const saved = await readStatusFile();
  const version = getActiveModuleBankVersion();
  const syncIntervalSec = getModuleBankSyncIntervalSec();
  const exists = await fs.pathExists(localPath);
  const gitDir = path.join(localPath, '.git');
  const isGit = remote && (await fs.pathExists(gitDir));

  let commit = saved.lastCommit;
  let message = saved.lastCommitMessage;
  if (isGit) {
    const head = await readHead(localPath);
    commit = head.commit || commit;
    message = head.message || message;
  }

  const status: ModuleBankStatus = {
    source,
    remote,
    version,
    ref: version,
    syncIntervalSec,
    localPath,
    syncStatus: remote
      ? (saved.syncStatus as ModuleBankSyncStatus) || (exists ? 'ok' : 'idle')
      : 'local',
    syncInProgress: syncInFlight !== null,
    lastSyncAt: saved.lastSyncAt,
    lastSyncError: saved.lastSyncError,
    lastCommit: commit,
    lastCommitMessage: message,
  };

  if (opts?.includeVersions !== false && remote) {
    try {
      status.availableVersions = await listModuleBankVersions();
    } catch {
      status.availableVersions = [version, 'main'];
    }
  }

  return status;
}

/**
 * Ensure a usable local tree exists. Clones if the checkout is empty.
 * Does not pull — use syncModuleBank() for updates.
 */
export async function ensureModuleBankPresent(): Promise<ModuleBankStatus> {
  await loadModuleBankSettings();
  if (!moduleBankIsRemote()) {
    const localPath = moduleBankLocalPath();
    if (!(await fs.pathExists(localPath))) {
      throw new Error(`Local module bank not found at ${localPath}`);
    }
    return writeStatus({
      syncStatus: 'local',
      localPath,
      source: String(config.moduleBank),
      remote: false,
      version: getActiveModuleBankVersion(),
      ref: getActiveModuleBankVersion(),
    });
  }

  const dest = moduleBankCheckoutDir();
  const gitDir = path.join(dest, '.git');
  if (await fs.pathExists(gitDir)) {
    const head = await readHead(dest);
    return writeStatus({
      syncStatus: 'ok',
      localPath: dest,
      lastCommit: head.commit,
      lastCommitMessage: head.message,
      lastSyncError: undefined,
      version: getActiveModuleBankVersion(),
      ref: getActiveModuleBankVersion(),
    });
  }

  return syncModuleBank();
}

/** Checkout the active version into the local module-bank tree. */
async function checkoutVersion(dest: string, version: string): Promise<void> {
  // Fetch tags + the requested ref so Sync can switch versions cleanly.
  await runGit(['fetch', 'origin', '--tags', '--force', '--prune'], dest);
  const fetchRef = await runGit(['fetch', 'origin', version], dest);
  if (fetchRef.code !== 0) {
    // Tag may already exist from --tags; try checkout anyway.
  }

  let checkout = await runGit(['checkout', '--force', version], dest);
  if (checkout.code !== 0) {
    checkout = await runGit(['checkout', '--force', '-B', version, `origin/${version}`], dest);
  }
  if (checkout.code !== 0) {
    throw new Error(
      checkout.stderr ||
        checkout.stdout ||
        `Failed to checkout module bank version "${version}"`
    );
  }
}

/**
 * Clone or update the module bank to the **active admin-selected version**.
 * Concurrent callers share one in-flight sync (no overlapping git operations).
 */
export async function syncModuleBank(): Promise<ModuleBankStatus> {
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    await loadModuleBankSettings();
    if (!moduleBankIsRemote()) {
      return ensureModuleBankPresent();
    }

    const url = normalizeRemoteUrl(String(config.moduleBank));
    const dest = moduleBankCheckoutDir();
    const version = getActiveModuleBankVersion();

    await writeStatus({
      syncStatus: 'syncing',
      lastSyncError: undefined,
      version,
      ref: version,
    });

    try {
      await fs.ensureDir(path.dirname(dest));
      const gitDir = path.join(dest, '.git');

      if (await fs.pathExists(gitDir)) {
        await runGit(['remote', 'set-url', 'origin', url], dest);
        await checkoutVersion(dest, version);
      } else {
        if (await fs.pathExists(dest)) {
          const entries = (await fs.readdir(dest)).filter((e) => e !== '.DS_Store');
          if (entries.length > 0) {
            throw new Error(
              `Module bank path ${dest} is non-empty but not a git checkout. Empty it or set GRID_MODULE_BANK_CACHE.`
            );
          }
        }
        await fs.ensureDir(dest);
        // Prefer shallow clone of the version (tag/branch).
        let clone = await runGit(
          ['clone', '--branch', version, '--single-branch', '--depth', '1', url, '.'],
          dest
        );
        if (clone.code !== 0) {
          // Fallback: full clone then checkout (needed for some commit SHAs).
          clone = await runGit(['clone', url, '.'], dest);
          if (clone.code !== 0) {
            const message = clone.stderr || clone.stdout || 'clone failed';
            await writeStatus({
              syncStatus: 'error',
              lastSyncAt: new Date().toISOString(),
              lastSyncError: message,
            });
            throw new Error(message);
          }
          await checkoutVersion(dest, version);
        }
      }

      const head = await readHead(dest);
      versionsCache = null; // refresh tag list after sync
      return writeStatus({
        syncStatus: 'ok',
        lastSyncAt: new Date().toISOString(),
        lastSyncError: undefined,
        lastCommit: head.commit,
        lastCommitMessage: head.message,
        localPath: dest,
        version,
        ref: version,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeStatus({
        syncStatus: 'error',
        lastSyncAt: new Date().toISOString(),
        lastSyncError: message,
        version,
        ref: version,
      });
      throw err;
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

export function startModuleBankAutoSync(intervalSec?: number): () => void {
  const sec = intervalSec ?? getModuleBankSyncIntervalSec();
  if (sec <= 0 || !moduleBankIsRemote()) {
    return () => undefined;
  }
  const ms = sec * 1000;
  console.log(
    `[module-bank] auto-sync every ${sec}s → version ${getActiveModuleBankVersion()} (manual Sync also available; overlapping syncs are skipped)`
  );
  const tick = () => {
    // Cutover lock: if a sync is already running, do not start another.
    if (syncInFlight) {
      console.log('[module-bank] auto-sync skipped — sync already in progress');
      return;
    }
    void syncModuleBank()
      .then((s) =>
        console.log(
          `[module-bank] auto-sync ok version=${s.version}` +
            (s.lastCommit ? ` @ ${s.lastCommit.slice(0, 8)}` : '')
        )
      )
      .catch((err) =>
        console.error(
          `[module-bank] auto-sync failed (retry next tick):`,
          err instanceof Error ? err.message : err
        )
      );
  };
  // Immediate first tick so startup converges quickly.
  tick();
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

/** Restart auto-sync after admin changes interval (or on boot). */
export function restartModuleBankAutoSync(): void {
  if (stopAutoSync) {
    stopAutoSync();
    stopAutoSync = null;
  }
  if (!moduleBankIsRemote()) return;
  const sec = getModuleBankSyncIntervalSec();
  if (sec <= 0) return;
  stopAutoSync = startModuleBankAutoSync(sec);
}
