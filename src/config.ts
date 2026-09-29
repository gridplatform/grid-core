import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

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
  terraformBin: process.env.GRID_TERRAFORM_BIN || 'terraform',
  /** API applies use -auto-approve unless GRID_AUTO_APPROVE=false */
  autoApprove: process.env.GRID_AUTO_APPROVE !== 'false',
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
    role: 'admin' as const,
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

/** Env injected into every CLI child. Core owns path SoT. */
export function cliChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GRID_CLI_ROOT: config.cliRoot,
    GRID_CONFIG_ROOT: config.configRoot,
    GRID_MODULE_BANK: config.moduleBank,
    GRID_MODULE_BANK_REF: config.moduleBankRef,
    GRID_DATA_DIR: config.dataDir,
    GRID_WORK_DIR: config.workDir,
    GRID_TERRAFORM_BIN: config.terraformBin,
    ...extra,
  };
}
