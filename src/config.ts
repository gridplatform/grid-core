import path from 'path';
import { loadAppEnv, type GridAppEnv } from './loadEnv';

// Must run before reading process.env below.
const appEnv: GridAppEnv = loadAppEnv();

function isGitRemote(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (/^git::/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^git@[^:]+:/.test(v)) return true;
  return false;
}

function requiredPath(envValue: string | undefined, fallback: string): string {
  return path.resolve(envValue || fallback);
}

/** Path or pass-through git URL (do not path.resolve remotes). */
function pathOrRemote(envValue: string | undefined, fallback: string): string {
  const raw = (envValue || fallback).trim();
  if (isGitRemote(raw)) return raw;
  return path.resolve(raw);
}

const cwd = process.cwd();

/**
 * Platform paths owned by Core; injected into CLI children via cliChildEnv.
 *
 * Desired-state: local working tree (`GRID_CONFIG_ROOT`), filled from
 * `GRID_GITOPS_REPO_URL` when using remote GitOps.
 * Module bank: local path or git URL (`GRID_MODULE_BANK`) — CLI clones URLs.
 */
export const config = {
  /** development (`npm run dev`) vs production (`npm run prod`). */
  appEnv,
  isDevelopment: appEnv === 'development',
  isProduction: appEnv === 'production',
  port: Number(process.env.PORT || 3000),
  dataDir: requiredPath(process.env.GRID_DATA_DIR, path.join(cwd, 'data')),
  /** Terraform workspace root for API-only units */
  workDir: requiredPath(process.env.GRID_WORK_DIR, path.join(cwd, 'workspaces')),
  /** grid-cli package root (templates/ + dist or src) */
  cliRoot: requiredPath(process.env.GRID_CLI_ROOT, path.join(cwd, '..', 'grid-cli')),
  /**
   * Desired-state working tree. When GRID_GITOPS_REPO_URL is set and
   * GRID_CONFIG_ROOT is unset, default to data/desired-state (remote checkout).
   * Otherwise fall back to ../demo-infra (fixture).
   */
  configRoot: requiredPath(
    process.env.GRID_CONFIG_ROOT,
    process.env.GRID_GITOPS_REPO_URL
      ? path.join(cwd, 'data', 'desired-state')
      : path.join(cwd, '..', 'demo-infra')
  ),
  /** True when using the demo-infra fixture (no GitOps remote, no explicit root) */
  configRootIsDemoFixture:
    (!process.env.GRID_CONFIG_ROOT && !process.env.GRID_GITOPS_REPO_URL) ||
    process.env.GRID_USE_DEMO === '1' ||
    process.env.GRID_USE_DEMO === 'true',
  /**
   * Module bank: local path or git URL (CLI clones URL into cache under GRID_DATA_DIR).
   */
  moduleBank: pathOrRemote(
    process.env.GRID_MODULE_BANK,
    path.join(cwd, '..', 'grid-terraform')
  ),
  moduleBankRef:
    process.env.GRID_MODULE_BANK_REF ||
    process.env.GRID_MODULE_BANK_BRANCH ||
    'main',
  /**
   * Optional auto pull for the module-bank checkout (seconds).
   * Default 20 when unset (admin can change via module-bank settings). 0 = manual only.
   */
  moduleBankSyncIntervalSec: Number(
    process.env.GRID_MODULE_BANK_SYNC_INTERVAL_SEC !== undefined &&
      process.env.GRID_MODULE_BANK_SYNC_INTERVAL_SEC !== ''
      ? process.env.GRID_MODULE_BANK_SYNC_INTERVAL_SEC
      : 20
  ),
  terraformBin: process.env.GRID_TERRAFORM_BIN || 'terraform',
  /** Optional GitOps bootstrap (also settable via API) */
  gitops: {
    repoUrl: process.env.GRID_GITOPS_REPO_URL || '',
    branch: process.env.GRID_GITOPS_BRANCH || 'main',
    pathPrefix: process.env.GRID_GITOPS_PATH || '',
    /** Auto Git pull + reconcile; 0 = off. Default 10m when a remote repo URL is set. */
    syncIntervalSec: Number(
      process.env.GRID_GITOPS_SYNC_INTERVAL_SEC ??
        (process.env.GRID_GITOPS_REPO_URL ? '600' : '0')
    ),
  },
  demoUser: {
    id: 'user-demo',
    email: 'demo@gridplatform.org',
    name: 'Grid Demo',
    role: 'superadmin' as const,
    createdAt: new Date().toISOString(),
  },
  /**
   * Internal user database (JSON under GRID_DATA_DIR/users.json).
   * Jenkins-style: local accounts + API session tokens; OIDC/SSO later.
   */
  auth: {
    disabled:
      process.env.GRID_AUTH_DISABLED === '1' ||
      process.env.GRID_AUTH_DISABLED === 'true',
    allowRegister:
      process.env.GRID_AUTH_ALLOW_REGISTER === '1' ||
      process.env.GRID_AUTH_ALLOW_REGISTER === 'true',
    sessionTtlHours: Number(process.env.GRID_AUTH_SESSION_TTL_HOURS || 168),
    bootstrap: {
      email: process.env.GRID_AUTH_ADMIN_EMAIL || '',
      password: process.env.GRID_AUTH_ADMIN_PASSWORD || '',
      name: process.env.GRID_AUTH_ADMIN_NAME || '',
    },
  },
};

function isGitRemoteBank(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^git::/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^git@[^:]+:/.test(v)) return true;
  if (v.endsWith('.git') && !path.isAbsolute(v) && !v.startsWith('.')) return true;
  return false;
}

/** Env injected into every CLI child. Core owns path SoT. */
export function cliChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const configuredBank = config.moduleBank;
  const bankIsRemote = isGitRemoteBank(configuredBank);

  // Local checkout for generate-time module introspection (variable names, etc.).
  let localCheckout = configuredBank;
  try {
    // Lazy require avoids circular import at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { moduleBankLocalPath } = require('./services/moduleBankService') as {
      moduleBankLocalPath: () => string;
    };
    localCheckout = moduleBankLocalPath();
  } catch {
    /* keep configured path */
  }

  // Active version from admin settings (falls back to GRID_MODULE_BANK_REF).
  let activeVersion = config.moduleBankRef;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveModuleBankVersion } = require('./services/moduleBankService') as {
      getActiveModuleBankVersion: () => string;
    };
    activeVersion = getActiveModuleBankVersion();
  } catch {
    /* keep env ref */
  }

  // Keep the git URL as GRID_MODULE_BANK so generated HCL uses git:: sources.
  // Point GRID_MODULE_BANK_CACHE at the Core-managed checkout (no per-generate pull).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRID_APP_ENV: config.appEnv,
    GRID_CLI_ROOT: config.cliRoot,
    GRID_CONFIG_ROOT: config.configRoot,
    GRID_MODULE_BANK: bankIsRemote ? configuredBank : localCheckout,
    GRID_MODULE_BANK_REF: activeVersion,
    GRID_DATA_DIR: config.dataDir,
    GRID_WORK_DIR: config.workDir,
    GRID_TERRAFORM_BIN: config.terraformBin,
    // CLI must not pull on every generate — Core Sync owns updates.
    GRID_MODULE_BANK_PULL: '0',
    ...extra,
  };

  if (bankIsRemote) {
    env.GRID_MODULE_BANK_CACHE = localCheckout;
    if (!process.env.GRID_MODULE_SOURCE && !extra.GRID_MODULE_SOURCE) {
      env.GRID_MODULE_SOURCE = 'remote';
    }
  }

  return env;
}
