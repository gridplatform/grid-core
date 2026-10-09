import path from 'path';
import fs from 'fs-extra';
import { config } from '../config';
import { readJsonSafe, writeJsonAtomic } from '../lib/jsonFile';
import type { GitOpsRuntimeStatus, GitOpsSettings } from '../types/gitops';

const SETTINGS_FILE = () => path.join(config.dataDir, 'gitops-settings.json');
const STATUS_FILE = () => path.join(config.dataDir, 'gitops-status.json');

/**
 * Desired-state working tree (GRID_CONFIG_ROOT).
 * Same root for local fixture and remote checkout; archive/ writes here.
 */
export function gitopsCloneDir(): string {
  return config.configRoot;
}

function settingsFromEnv(): GitOpsSettings | null {
  if (!config.gitops.repoUrl) return null;
  return {
    repoUrl: config.gitops.repoUrl,
    branch: config.gitops.branch,
    pathPrefix: config.gitops.pathPrefix,
    syncIntervalSec: config.gitops.syncIntervalSec,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
}

export async function loadGitOpsSettings(): Promise<GitOpsSettings | null> {
  await fs.ensureDir(config.dataDir);
  const fromEnv = settingsFromEnv();
  const existing = await readJsonSafe<GitOpsSettings>(SETTINGS_FILE(), {
    label: 'gitops-settings.json',
  });

  if (!existing) {
    if (fromEnv) {
      await saveGitOpsSettings(fromEnv);
      return fromEnv;
    }
    return null;
  }

  // Env wins when set (remote public repos / CI) — keep file fields otherwise.
  if (fromEnv) {
    const merged: GitOpsSettings = {
      ...existing,
      repoUrl: fromEnv.repoUrl,
      branch: fromEnv.branch || existing.branch,
      pathPrefix: fromEnv.pathPrefix ?? existing.pathPrefix,
      syncIntervalSec:
        process.env.GRID_GITOPS_SYNC_INTERVAL_SEC !== undefined
          ? fromEnv.syncIntervalSec
          : existing.syncIntervalSec,
      enabled: existing.enabled !== false,
      updatedAt: new Date().toISOString(),
    };
    await saveGitOpsSettings(merged);
    return merged;
  }
  return existing;
}

export async function saveGitOpsSettings(settings: GitOpsSettings): Promise<GitOpsSettings> {
  await fs.ensureDir(config.dataDir);
  settings.updatedAt = new Date().toISOString();
  await writeJsonAtomic(SETTINGS_FILE(), settings);
  return settings;
}

export async function loadGitOpsRuntime(): Promise<GitOpsRuntimeStatus> {
  await fs.ensureDir(config.dataDir);
  const settings = await loadGitOpsSettings();
  const status = await readJsonSafe<GitOpsRuntimeStatus>(STATUS_FILE(), {
    label: 'gitops-status.json',
  });
  if (!status) {
    return {
      settings,
      syncStatus: 'idle',
      trackedCount: 0,
      clonePath: gitopsCloneDir(),
    };
  }
  status.settings = settings;
  status.clonePath = gitopsCloneDir();
  return status;
}

export async function saveGitOpsRuntime(
  patch: Partial<GitOpsRuntimeStatus>
): Promise<GitOpsRuntimeStatus> {
  const current = await loadGitOpsRuntime();
  const next: GitOpsRuntimeStatus = {
    ...current,
    ...patch,
    settings: patch.settings !== undefined ? patch.settings : current.settings,
  };
  await writeJsonAtomic(STATUS_FILE(), next);
  return next;
}
