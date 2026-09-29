import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { v5 as uuidv5 } from 'uuid';
import type { CloudProviderType, Infrastructure } from '../types/api';
import type { GitOpsSettings } from '../types/gitops';
import {
  createInfrastructure,
  getInfrastructure,
  listInfrastructures,
  saveInfrastructure,
} from '../store/memoryStore';
import {
  gitopsCloneDir,
  loadGitOpsSettings,
  saveGitOpsRuntime,
} from '../store/gitopsStore';
import { hashContent } from './gitopsHash';

/** UUID v5 namespace for path → infra id */
const GRID_GITOPS_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
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

function providerFromConfig(cfg: Record<string, unknown>): CloudProviderType {
  const p = String(cfg.provider || 'aws').toLowerCase();
  if (p === 'gcp') return 'GCP';
  if (p === 'azure') return 'Azure';
  if (p === 'on-prem' || p === 'onprem') return 'On-Prem';
  return 'AWS';
}

function nameFromConfig(cfg: Record<string, unknown>, fallback: string): string {
  const meta = cfg.metadata as { name?: string } | undefined;
  return meta?.name || (typeof cfg.name === 'string' ? cfg.name : fallback);
}

function environmentFromConfig(cfg: Record<string, unknown>): string {
  const meta = cfg.metadata as { environment?: string } | undefined;
  return meta?.environment || (typeof cfg.environment === 'string' ? cfg.environment : 'dev');
}

function infraIdForPath(gitPath: string, cfg: Record<string, unknown>): string {
  const explicit =
    (cfg.id as string | undefined) ||
    ((cfg.metadata as { id?: string } | undefined)?.id);
  if (explicit && /^[0-9a-f-]{36}$/i.test(explicit)) return explicit;
  return uuidv5(gitPath, GRID_GITOPS_NS);
}

async function discoverGridJsonFiles(
  root: string,
  pathPrefix: string
): Promise<Array<{ abs: string; gitPath: string }>> {
  const base =
    !pathPrefix || pathPrefix === '.' || pathPrefix === './'
      ? root
      : path.join(root, pathPrefix);
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
      await runGit(['remote', 'set-url', 'origin', settings.repoUrl], root);
      const fetch = await runGit(['fetch', 'origin', settings.branch], root);
      if (fetch.code !== 0) {
        throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`);
      }
      const checkout = await runGit(
        ['checkout', '-B', settings.branch, `origin/${settings.branch}`],
        root
      );
      if (checkout.code !== 0) {
        throw new Error(`git checkout failed: ${checkout.stderr || checkout.stdout}`);
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
  const clone = await runGit(
    [
      'clone',
      '--branch',
      settings.branch,
      '--single-branch',
      settings.repoUrl,
      '.',
    ],
    root
  );
  if (clone.code !== 0) {
    throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
  }
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

/**
 * Read GRID_CONFIG_ROOT desired-state JSON and upsert Infrastructure records.
 */
export async function syncGitOpsRepo(): Promise<SyncResult> {
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
      const id = infraIdForPath(file.gitPath, cfg);
      const contentHash = hashContent(cfg);
      const existing = await getInfrastructure(id);
      const folderName = path.basename(path.dirname(file.gitPath));

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
