import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function requiredPath(envValue: string | undefined, fallback: string): string {
  return path.resolve(envValue || fallback);
}

const cwd = process.cwd();

/**
 * Platform paths owned by Core; injected into CLI children via cliChildEnv.
 * GRID_CONFIG_ROOT is the single desired-state tree (intent JSON + archive/).
 */
export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: requiredPath(process.env.GRID_DATA_DIR, path.join(cwd, 'data')),
  /** Terraform workspace root for API-only units */
  workDir: requiredPath(process.env.GRID_WORK_DIR, path.join(cwd, 'workspaces')),
  /** grid-cli package root (templates/ + dist or src) */
  cliRoot: requiredPath(process.env.GRID_CLI_ROOT, path.join(cwd, '..', 'grid-cli')),
  /**
   * Desired-state root. Set GRID_CONFIG_ROOT to the grid init repo;
   * unset falls back to ../demo-infra (fixture).
   */
  configRoot: requiredPath(
    process.env.GRID_CONFIG_ROOT,
    path.join(cwd, '..', 'demo-infra')
  ),
  /** True when configRoot is the demo-infra fixture */
  configRootIsDemoFixture:
    !process.env.GRID_CONFIG_ROOT ||
    process.env.GRID_USE_DEMO === '1' ||
    process.env.GRID_USE_DEMO === 'true',
  /** Module bank path; passed to CLI as GRID_MODULE_BANK */
  moduleBank: requiredPath(
    process.env.GRID_MODULE_BANK,
    path.join(cwd, '..', 'grid-terraform')
  ),
  terraformBin: process.env.GRID_TERRAFORM_BIN || 'terraform',
  /** API applies use -auto-approve unless GRID_AUTO_APPROVE=false */
  autoApprove: process.env.GRID_AUTO_APPROVE !== 'false',
  /** Optional GitOps bootstrap (also settable via API) */
  gitops: {
    repoUrl: process.env.GRID_GITOPS_REPO_URL || '',
    branch: process.env.GRID_GITOPS_BRANCH || 'main',
    pathPrefix: process.env.GRID_GITOPS_PATH || '',
    syncIntervalSec: Number(process.env.GRID_GITOPS_SYNC_INTERVAL_SEC || 0),
  },
  demoUser: {
    id: 'user-demo',
    email: 'demo@gridplatform.org',
    name: 'Grid Demo',
    role: 'admin' as const,
    createdAt: new Date().toISOString(),
  },
};

/** Env injected into every CLI child. Core owns path SoT. */
export function cliChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GRID_CLI_ROOT: config.cliRoot,
    GRID_CONFIG_ROOT: config.configRoot,
    GRID_MODULE_BANK: config.moduleBank,
    GRID_WORK_DIR: config.workDir,
    GRID_DATA_DIR: config.dataDir,
    GRID_TERRAFORM_BIN: config.terraformBin,
    ...extra,
  };
}
