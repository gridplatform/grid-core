import path from 'path';
import fs from 'fs-extra';
import { config } from '../config';
import { readJsonSafe, writeJsonAtomic } from '../lib/jsonFile';
import {
  peelGitRemoteUserinfo,
  redactGitRemoteUrl,
} from '../lib/gitRemoteAuth';
import type {
  GitOpsRuntimeStatus,
  GitOpsSecrets,
  GitOpsSettings,
} from '../types/gitops';

const SETTINGS_FILE = () => path.join(config.dataDir, 'gitops-settings.json');
const SECRETS_FILE = () => path.join(config.dataDir, 'gitops-secrets.json');
const STATUS_FILE = () => path.join(config.dataDir, 'gitops-status.json');

/**
 * Desired-state working tree (GRID_CONFIG_ROOT).
 * Same root for local fixture and remote checkout; archive/ writes here.
 */
export function gitopsCloneDir(): string {
  return config.configRoot;
}

async function writeSecretsFile(secrets: GitOpsSecrets): Promise<void> {
  await fs.ensureDir(config.dataDir);
  await writeJsonAtomic(SECRETS_FILE(), secrets);
  try {
    await fs.chmod(SECRETS_FILE(), 0o600);
  } catch {
    // Windows / some FS ignore chmod — best effort.
  }
}

export async function loadGitOpsSecrets(): Promise<GitOpsSecrets | null> {
  await fs.ensureDir(config.dataDir);
  const fromFile = await readJsonSafe<GitOpsSecrets>(SECRETS_FILE(), {
    label: 'gitops-secrets.json',
  });
  if (fromFile?.token) return fromFile;

  const envToken = process.env.GRID_GITOPS_TOKEN?.trim();
  if (!envToken) return fromFile?.token ? fromFile : null;

  const seeded: GitOpsSecrets = {
    username: process.env.GRID_GITOPS_USERNAME?.trim() || undefined,
    token: envToken,
    tokenExpiresAt: process.env.GRID_GITOPS_TOKEN_EXPIRES_AT?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeSecretsFile(seeded);
  return seeded;
}

function normalizeExpiresAt(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const t = String(raw).trim();
  if (!t) return undefined;
  // Accept YYYY-MM-DD or full ISO; store calendar date when possible.
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export async function saveGitOpsSecrets(
  secrets: GitOpsSecrets | null
): Promise<void> {
  await fs.ensureDir(config.dataDir);
  if (!secrets?.token) {
    if (await fs.pathExists(SECRETS_FILE())) {
      await fs.remove(SECRETS_FILE());
    }
    return;
  }
  await writeSecretsFile({
    username: secrets.username?.trim() || undefined,
    token: secrets.token,
    tokenExpiresAt: normalizeExpiresAt(secrets.tokenExpiresAt),
    updatedAt: new Date().toISOString(),
  });
}

export async function gitOpsAuthConfigured(): Promise<boolean> {
  const s = await loadGitOpsSecrets();
  return Boolean(s?.token);
}

/**
 * Persist settings with a clean repo URL. Any userinfo in the URL is moved into secrets.
 */
export async function normalizeAndSaveGitOpsSettings(
  settings: GitOpsSettings,
  options?: {
    /** New token from API (empty string = leave unchanged; null = clear) */
    token?: string | null;
    username?: string | null;
    /**
     * When the host token expires (`YYYY-MM-DD`).
     * null clears; undefined keeps existing when not rotating token.
     */
    tokenExpiresAt?: string | null;
  }
): Promise<GitOpsSettings> {
  const peeled = peelGitRemoteUserinfo(settings.repoUrl);
  const clean: GitOpsSettings = {
    ...settings,
    repoUrl: peeled.cleanUrl,
    updatedAt: new Date().toISOString(),
  };

  const existingSecrets = await loadGitOpsSecrets();
  let nextSecrets: GitOpsSecrets | null = existingSecrets;

  if (options?.token === null) {
    nextSecrets = null;
  } else if (typeof options?.token === 'string' && options.token.length > 0) {
    nextSecrets = {
      username:
        options.username === null
          ? undefined
          : options.username?.trim() ||
            existingSecrets?.username ||
            peeled.username,
      token: options.token,
      tokenExpiresAt:
        options.tokenExpiresAt === null
          ? undefined
          : normalizeExpiresAt(options.tokenExpiresAt) ||
            existingSecrets?.tokenExpiresAt,
      updatedAt: new Date().toISOString(),
    };
  } else if (peeled.token) {
    nextSecrets = {
      username: peeled.username || existingSecrets?.username,
      token: peeled.token,
      tokenExpiresAt:
        options?.tokenExpiresAt === null
          ? undefined
          : normalizeExpiresAt(options?.tokenExpiresAt) ||
            existingSecrets?.tokenExpiresAt,
      updatedAt: new Date().toISOString(),
    };
  } else if (
    existingSecrets?.token &&
    (options?.username !== undefined || options?.tokenExpiresAt !== undefined)
  ) {
    nextSecrets = {
      ...existingSecrets,
      username:
        options.username === null
          ? undefined
          : options.username !== undefined
            ? options.username.trim() || undefined
            : existingSecrets.username,
      tokenExpiresAt:
        options.tokenExpiresAt === null
          ? undefined
          : options.tokenExpiresAt !== undefined
            ? normalizeExpiresAt(options.tokenExpiresAt)
            : existingSecrets.tokenExpiresAt,
      updatedAt: new Date().toISOString(),
    };
  }

  // Env bootstrap token when nothing else is stored yet.
  if (!nextSecrets?.token) {
    const envToken = process.env.GRID_GITOPS_TOKEN?.trim();
    if (envToken) {
      nextSecrets = {
        username:
          process.env.GRID_GITOPS_USERNAME?.trim() ||
          nextSecrets?.username ||
          peeled.username,
        token: envToken,
        tokenExpiresAt:
          normalizeExpiresAt(process.env.GRID_GITOPS_TOKEN_EXPIRES_AT) ||
          nextSecrets?.tokenExpiresAt,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  await saveGitOpsSecrets(nextSecrets);
  await saveGitOpsSettings(clean);
  return clean;
}

function settingsFromEnv(): GitOpsSettings | null {
  if (!config.gitops.repoUrl) return null;
  const peeled = peelGitRemoteUserinfo(config.gitops.repoUrl);
  return {
    repoUrl: peeled.cleanUrl,
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
      const peeledEnv = peelGitRemoteUserinfo(config.gitops.repoUrl);
      await normalizeAndSaveGitOpsSettings(fromEnv, {
        token: peeledEnv.token,
        username: peeledEnv.username,
      });
      return (await readJsonSafe<GitOpsSettings>(SETTINGS_FILE(), {
        label: 'gitops-settings.json',
      }))!;
    }
    return null;
  }

  // Migrate legacy credentials embedded in stored URL.
  const peeledExisting = peelGitRemoteUserinfo(existing.repoUrl);
  if (peeledExisting.token || peeledExisting.cleanUrl !== existing.repoUrl) {
    await normalizeAndSaveGitOpsSettings(
      { ...existing, repoUrl: peeledExisting.cleanUrl },
      {
        token: peeledExisting.token,
        username: peeledExisting.username,
      }
    );
  }

  // Env wins for non-secret fields when set (CI / install).
  if (fromEnv) {
    const peeledEnv = peelGitRemoteUserinfo(config.gitops.repoUrl);
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
    await normalizeAndSaveGitOpsSettings(merged, {
      token: peeledEnv.token,
      username: peeledEnv.username,
    });
  }

  const latest = await readJsonSafe<GitOpsSettings>(SETTINGS_FILE(), {
    label: 'gitops-settings.json',
  });
  return latest;
}

export async function saveGitOpsSettings(settings: GitOpsSettings): Promise<GitOpsSettings> {
  await fs.ensureDir(config.dataDir);
  const { authConfigured: _a, ...rest } = settings;
  const toWrite: GitOpsSettings = {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(SETTINGS_FILE(), toWrite);
  return toWrite;
}

/** Settings safe for API responses (clean URL + auth metadata, never the token). */
export async function publicGitOpsSettings(
  settings: GitOpsSettings
): Promise<GitOpsSettings> {
  const secrets = await loadGitOpsSecrets();
  return {
    ...settings,
    repoUrl: redactGitRemoteUrl(settings.repoUrl) || settings.repoUrl,
    authConfigured: Boolean(secrets?.token),
    authExpiresAt: secrets?.tokenExpiresAt,
  };
}

export async function loadGitOpsRuntime(): Promise<GitOpsRuntimeStatus> {
  await fs.ensureDir(config.dataDir);
  const settings = await loadGitOpsSettings();
  const status = await readJsonSafe<GitOpsRuntimeStatus>(STATUS_FILE(), {
    label: 'gitops-status.json',
  });
  const publicSettings = settings ? await publicGitOpsSettings(settings) : null;
  if (!status) {
    return {
      settings: publicSettings,
      syncStatus: 'idle',
      trackedCount: 0,
      clonePath: gitopsCloneDir(),
    };
  }
  status.settings = publicSettings;
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
