import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { config } from '../config';

/**
 * Module bank (grid-terraform) checkout — same idea as desired-state GitOps:
 * clone once onto local disk / PVC, use that path for generate/plan/apply,
 * refresh only when Sync is requested (or optional interval).
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
  cwd: string
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

export type ModuleBankSyncStatus = 'idle' | 'syncing' | 'ok' | 'error' | 'local';

export interface ModuleBankStatus {
  /** Configured source (URL or local path). */
  source: string;
  /** True when GRID_MODULE_BANK is a git remote. */
  remote: boolean;
  ref: string;
  /** Local path Terraform generate uses (checkout or sibling path). */
  localPath: string;
  syncStatus: ModuleBankSyncStatus;
  lastSyncAt?: string;
  lastSyncError?: string;
  lastCommit?: string;
  lastCommitMessage?: string;
}

let syncInFlight: Promise<ModuleBankStatus> | null = null;

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
 * Path injected into CLI children. Remote banks resolve to the local checkout
 * so generate never hits the network.
 */
export function moduleBankLocalPath(): string {
  if (moduleBankIsRemote()) return moduleBankCheckoutDir();
  return path.resolve(String(config.moduleBank));
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
  const current = await getModuleBankStatus();
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

export async function getModuleBankStatus(): Promise<ModuleBankStatus> {
  const source = String(config.moduleBank || '');
  const remote = moduleBankIsRemote();
  const localPath = moduleBankLocalPath();
  const saved = await readStatusFile();
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

  return {
    source,
    remote,
    ref: config.moduleBankRef,
    localPath,
    syncStatus: remote
      ? (saved.syncStatus as ModuleBankSyncStatus) || (exists ? 'ok' : 'idle')
      : 'local',
    lastSyncAt: saved.lastSyncAt,
    lastSyncError: saved.lastSyncError,
    lastCommit: commit,
    lastCommitMessage: message,
  };
}

/**
 * Ensure a usable local tree exists. Clones if the checkout is empty.
 * Does not pull — use syncModuleBank() for updates (fast path for generate).
 */
export async function ensureModuleBankPresent(): Promise<ModuleBankStatus> {
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
      ref: config.moduleBankRef,
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
    });
  }

  return syncModuleBank();
}

/**
 * Clone or ff-only pull the module bank into the local checkout.
 * Call from UI Sync / boot / optional interval — not on every generate.
 */
export async function syncModuleBank(): Promise<ModuleBankStatus> {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    if (!moduleBankIsRemote()) {
      return ensureModuleBankPresent();
    }

    const url = normalizeRemoteUrl(String(config.moduleBank));
    const dest = moduleBankCheckoutDir();
    const ref = config.moduleBankRef;

    await writeStatus({ syncStatus: 'syncing', lastSyncError: undefined });

    try {
      await fs.ensureDir(path.dirname(dest));
      const gitDir = path.join(dest, '.git');

      if (await fs.pathExists(gitDir)) {
        await runGit(['remote', 'set-url', 'origin', url], dest);
        const pull = await runGit(['pull', '--ff-only', 'origin', ref], dest);
        if (pull.code !== 0) {
          const message = pull.stderr || pull.stdout || 'ff-only pull failed';
          await writeStatus({
            syncStatus: 'error',
            lastSyncAt: new Date().toISOString(),
            lastSyncError: message,
          });
          throw new Error(message);
        }
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
        const clone = await runGit(
          ['clone', '--branch', ref, '--single-branch', '--depth', '1', url, '.'],
          dest
        );
        if (clone.code !== 0) {
          const message = clone.stderr || clone.stdout || 'clone failed';
          await writeStatus({
            syncStatus: 'error',
            lastSyncAt: new Date().toISOString(),
            lastSyncError: message,
          });
          throw new Error(message);
        }
      }

      const head = await readHead(dest);
      return writeStatus({
        syncStatus: 'ok',
        lastSyncAt: new Date().toISOString(),
        lastSyncError: undefined,
        lastCommit: head.commit,
        lastCommitMessage: head.message,
        localPath: dest,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeStatus({
        syncStatus: 'error',
        lastSyncAt: new Date().toISOString(),
        lastSyncError: message,
      });
      throw err;
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

export function startModuleBankAutoSync(intervalSec: number): () => void {
  if (intervalSec <= 0 || !moduleBankIsRemote()) {
    return () => undefined;
  }
  const ms = intervalSec * 1000;
  console.log(
    `[module-bank] auto-sync every ${intervalSec}s (manual Sync also available; generate uses local checkout only)`
  );
  const tick = () => {
    void syncModuleBank()
      .then((s) =>
        console.log(
          `[module-bank] auto-sync ok` +
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
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}
