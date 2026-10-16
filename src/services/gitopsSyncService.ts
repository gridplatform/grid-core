import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import type { Infrastructure } from '../types/api';
import type { GitOpsSettings } from '../types/gitops';
import {
  createInfrastructure,
  getInfrastructure,
  listInfrastructures,
  saveInfrastructure,
} from '../store/memoryStore';
import {
  gitopsCloneDir,
  loadGitOpsSecrets,
  loadGitOpsSettings,
  saveGitOpsRuntime,
} from '../store/gitopsStore';
import { authenticatedGitRemoteUrl } from '../lib/gitRemoteAuth';
import { hashContent } from './gitopsHash';
import {
  environmentFromMetadata,
  nameFromConfig,
} from './configFields';
import { providerFromConfig } from './providerLabels';
import { projectSlugFromGitPath } from './projectsService';
import { ensureUnitIdInConfig } from './unitIdentity';
import { resolveUnderRoot } from '../lib/safePath';

function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        // Avoid interactive prompts hanging Sync when auth is missing.
        GIT_TERMINAL_PROMPT: '0',
      },
    });
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

async function remoteUrlForSync(settings: GitOpsSettings): Promise<string> {
  const secrets = await loadGitOpsSecrets();
  return authenticatedGitRemoteUrl(settings.repoUrl, secrets);
}

function environmentFromConfig(cfg: Record<string, unknown>): string {
  return environmentFromMetadata(cfg) || 'dev';
}

async function discoverGridJsonFiles(
  root: string,
  pathPrefix: string
): Promise<Array<{ abs: string; gitPath: string }>> {
  let base: string;
  try {
    base =
      !pathPrefix || pathPrefix === '.' || pathPrefix === './'
        ? path.resolve(root)
        : resolveUnderRoot(root, pathPrefix);
  } catch (err) {
    throw new Error(
      `Invalid GitOps pathPrefix: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!(await fs.pathExists(base))) return [];

  const found: Array<{ abs: string; gitPath: string }> = [];
  const skipDirs = new Set(['.git', '.grid', 'node_modules', 'scripts', 'archive']);
  const skipNames = new Set([
    'catalog_index.json',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ]);

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        await walk(abs);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      if (skipNames.has(ent.name.toLowerCase())) continue;
      if (ent.name === 'CATALOG_INDEX.json') continue;

      // Legacy grid.json names; other *.json must look like Grid config
      const legacy =
        ent.name === 'grid.json' || ent.name.endsWith('.grid.json');
      if (!legacy) {
        try {
          const cfg = (await fs.readJSON(abs)) as Record<string, unknown>;
          if (typeof cfg.provider !== 'string' || !Array.isArray(cfg.resources)) {
            continue;
          }
        } catch {
          continue;
        }
      }

      const gitPath = path.relative(root, abs).split(path.sep).join('/');
      found.push({ abs, gitPath });
    }
  };

  await walk(base);
  return found;
}

/**
 * Ensure GRID_CONFIG_ROOT is ready as the desired-state tree.
 * Git checkout → fetch/checkout; non-empty/local → leave as-is; empty + URL → clone.
 */
async function ensureClone(settings: GitOpsSettings): Promise<string> {
  const root = gitopsCloneDir();
  await fs.ensureDir(root);
  const gitDir = path.join(root, '.git');

  if (await fs.pathExists(gitDir)) {
    if (settings.repoUrl) {
      const remote = await remoteUrlForSync(settings);
      await runGit(['remote', 'set-url', 'origin', remote], root);
      // GitOps clone is a mirror of origin — not a place for local edits.
      // Dirty trees (manual edits, old scripts, accidental writes) used to make
      // `pull --ff-only` skip forever. Always discard local tracked changes and
      // match origin/<branch>. Untracked paths (e.g. generated archive/) are kept.
      const fetch = await runGit(['fetch', 'origin', settings.branch], root);
      // Drop credentials from the stored remote URL after fetch (secrets stay in data dir).
      await runGit(['remote', 'set-url', 'origin', settings.repoUrl], root);
      if (fetch.code !== 0) {
        console.warn(
          `[gitops] fetch failed (${fetch.stderr || fetch.stdout || 'unknown'}). Keeping local tree.`
        );
        return root;
      }
      const target = `origin/${settings.branch}`;
      // -B: point local branch at origin tip (hard reset of tracked files).
      const checkout = await runGit(['checkout', '-B', settings.branch, target], root);
      if (checkout.code !== 0) {
        const fallback = await runGit(['reset', '--hard', 'FETCH_HEAD'], root);
        if (fallback.code !== 0) {
          console.warn(
            `[gitops] sync to ${target} failed (${checkout.stderr || checkout.stdout || fallback.stderr || 'unknown'}). Keeping local tree.`
          );
        } else {
          console.log(`[gitops] reset working tree to FETCH_HEAD (${settings.branch})`);
        }
      } else {
        console.log(`[gitops] synced working tree to ${target}`);
      }
    }
    return root;
  }

  // Non-empty or no remote: keep on-disk tree.
  const entries = await fs.readdir(root);
  const meaningful = entries.filter((e) => e !== '.DS_Store');
  if (meaningful.length > 0 || !settings.repoUrl) {
    return root;
  }

  // Empty root + remote → clone into GRID_CONFIG_ROOT.
  const remote = await remoteUrlForSync(settings);
  const clone = await runGit(
    [
      'clone',
      '--branch',
      settings.branch,
      '--single-branch',
      remote,
      '.',
    ],
    root
  );
  if (clone.code !== 0) {
    throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
  }
  // Persist a clean origin URL (token stays in gitops-secrets.json).
  await runGit(['remote', 'set-url', 'origin', settings.repoUrl], root);
  return root;
}

export interface SyncResult {
  synced: number;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Infra with missing gitPath — marked stale; not auto-destroyed */
  stale: string[];
  commit?: string;
  commitMessage?: string;
}

export type GitOpsSyncBusy = 'skip' | 'join' | 'fail';

export class GitOpsSyncInProgressError extends Error {
  constructor() {
    super('GitOps sync is already in progress');
    this.name = 'GitOpsSyncInProgressError';
  }
}

let syncInFlight: Promise<SyncResult> | null = null;

export function isGitOpsSyncInProgress(): boolean {
  return syncInFlight !== null;
}

/**
 * Read GRID_CONFIG_ROOT desired-state JSON and upsert Infrastructure records.
 *
 * @param ifBusy — auto-sync uses `skip` (snooze to next interval); manual sync uses `fail`.
 */
export async function syncGitOpsRepo(options?: {
  ifBusy?: GitOpsSyncBusy;
}): Promise<SyncResult | null> {
  const ifBusy = options?.ifBusy ?? 'join';
  if (syncInFlight) {
    if (ifBusy === 'skip') return null;
    if (ifBusy === 'fail') throw new GitOpsSyncInProgressError();
    return syncInFlight;
  }

  syncInFlight = runGitOpsSyncInternal().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function runGitOpsSyncInternal(): Promise<SyncResult> {
  const settings = await loadGitOpsSettings();
  if (!settings || !settings.enabled || !settings.repoUrl) {
    throw new Error('GitOps is not configured. Set repo URL under GitOps settings.');
  }

  await saveGitOpsRuntime({ syncStatus: 'syncing', lastSyncError: undefined });

  try {
    const clonePath = await ensureClone(settings);
    const head = await runGit(['rev-parse', 'HEAD'], clonePath);
    const msg = await runGit(['log', '-1', '--pretty=%s'], clonePath);
    const commit = head.stdout.trim();
    const commitMessage = msg.stdout.trim();

    const files = await discoverGridJsonFiles(clonePath, settings.pathPrefix);
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const seenPaths = new Set<string>();

    for (const file of files) {
      seenPaths.add(file.gitPath);
      const cfg = (await fs.readJSON(file.abs)) as Record<string, unknown>;
      // Prefer metadata.id if set; else UUID v5(path). Never stamp into Git.
      const { id } = ensureUnitIdInConfig(file.gitPath, cfg);
      const contentHash = hashContent(cfg);
      const existing = await getInfrastructure(id);
      const folderName = path.basename(path.dirname(file.gitPath));
      const project = projectSlugFromGitPath(file.gitPath);

      if (!existing) {
        await createInfrastructure({
          id,
          name: nameFromConfig(cfg, folderName),
          environment: environmentFromConfig(cfg),
          provider: providerFromConfig(cfg),
          configJson: cfg,
          status: 'pending',
          autoApprove: true,
          driftDetection: true,
          gitRepo: settings.repoUrl,
          gitBranch: settings.branch,
          gitPath: file.gitPath,
          gitCommit: commit,
          gitContentHash: contentHash,
          project,
        });
        created.push(id);
      } else {
        const same = existing.gitContentHash === contentHash;
        const next: Infrastructure = {
          ...existing,
          configJson: cfg,
          gitPath: file.gitPath,
          gitCommit: commit,
          gitContentHash: contentHash,
          gitRepo: settings.repoUrl,
          gitBranch: settings.branch,
          name: nameFromConfig(cfg, existing.name),
          environment: environmentFromConfig(cfg),
          provider: providerFromConfig(cfg),
          project,
          driftDetection: true,
          // Clear stale when file reappears
          status: existing.status === 'stale' ? 'pending' : existing.status,
          updatedAt: new Date().toISOString(),
        };
        await saveInfrastructure(next);
        if (same) unchanged.push(id);
        else updated.push(id);
      }
    }

    // Missing JSON → stale only (no auto-destroy)
    const stale: string[] = [];
    const all = await listInfrastructures();
    for (const infra of all) {
      if (!infra.gitPath) continue;
      if (infra.status === 'destroyed') continue;
      if (seenPaths.has(infra.gitPath)) continue;
      if (infra.gitRepo && settings.repoUrl && infra.gitRepo !== settings.repoUrl) {
        continue;
      }
      const next: Infrastructure = {
        ...infra,
        status: 'stale',
        updatedAt: new Date().toISOString(),
      };
      await saveInfrastructure(next);
      stale.push(infra.id);
    }

    const result: SyncResult = {
      synced: files.length,
      created,
      updated,
      unchanged,
      stale,
      commit,
      commitMessage,
    };

    await saveGitOpsRuntime({
      syncStatus: 'ok',
      lastSyncAt: new Date().toISOString(),
      lastSyncError: undefined,
      lastCommit: commit,
      lastCommitMessage: commitMessage,
      trackedCount: files.length,
    });

    // Invalidate list-sync TTL so next UI load sees the new tree.
    const { syncInfrastructuresFromConfigRoot } = await import('./configRootSync');
    const { invalidateConfigDiscoveryCache } = await import('./configDiscovery');
    invalidateConfigDiscoveryCache();
    void syncInfrastructuresFromConfigRoot({ force: true });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveGitOpsRuntime({
      syncStatus: 'error',
      lastSyncError: message,
      lastSyncAt: new Date().toISOString(),
    });
    throw err;
  }
}

export { hashContent };
