import path from 'path';
import fs from 'fs-extra';
import { config } from '../config';
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

export async function loadGitOpsSettings(): Promise<GitOpsSettings | null> {
  await fs.ensureDir(config.dataDir);
  if (!(await fs.pathExists(SETTINGS_FILE()))) {
    if (config.gitops.repoUrl) {
      const seeded: GitOpsSettings = {
        repoUrl: config.gitops.repoUrl,
        branch: config.gitops.branch,
        pathPrefix: config.gitops.pathPrefix,
        syncIntervalSec: config.gitops.syncIntervalSec,
        enabled: true,
        updatedAt: new Date().toISOString(),
      };
      await saveGitOpsSettings(seeded);
      return seeded;
    }
    return null;
  }
  return fs.readJSON(SETTINGS_FILE());
}

export async function saveGitOpsSettings(settings: GitOpsSettings): Promise<GitOpsSettings> {
  await fs.ensureDir(config.dataDir);
  settings.updatedAt = new Date().toISOString();
  await fs.writeJSON(SETTINGS_FILE(), settings, { spaces: 2 });
  return settings;
}

export async function loadGitOpsRuntime(): Promise<GitOpsRuntimeStatus> {
  await fs.ensureDir(config.dataDir);
  const settings = await loadGitOpsSettings();
  if (!(await fs.pathExists(STATUS_FILE()))) {
    return {
      settings,
      syncStatus: 'idle',
      trackedCount: 0,
      clonePath: gitopsCloneDir(),
    };
  }
  const status = (await fs.readJSON(STATUS_FILE())) as GitOpsRuntimeStatus;
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
  await fs.writeJSON(STATUS_FILE(), next, { spaces: 2 });
  return next;
}
