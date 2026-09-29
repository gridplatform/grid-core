import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function requiredPath(envValue: string | undefined, fallback: string): string {
  return path.resolve(envValue || fallback);
}

const cwd = process.cwd();

/**
 * Grid Core owns platform paths. The CLI is an add-on: when Core spawns it,
 * these values are injected as env (see cliChildEnv). Do not hardcode
 * grid-config / module-bank locations in the CLI as product SoT.
 */
export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: requiredPath(process.env.GRID_DATA_DIR, path.join(cwd, 'data')),
  /** Directory where terraform workspaces are written */
  workDir: requiredPath(process.env.GRID_WORK_DIR, path.join(cwd, 'workspaces')),
  /**
   * Path to grid-cli package root (must contain templates/ and built or tsx-runnable src).
   * Default: sibling ../grid-cli
   */
  cliRoot: requiredPath(process.env.GRID_CLI_ROOT, path.join(cwd, '..', 'grid-cli')),
  /**
   * Desired-state root (customer Git repo in real installs).
   *
   * - Production / normal: set GRID_CONFIG_ROOT to the repo from `grid init`.
   * - Local API testing only: omit it and we fall back to ../demo-infra when
   *   GRID_USE_DEMO=1, otherwise still ../demo-infra with a startup warning.
   */
  configRoot: requiredPath(
    process.env.GRID_CONFIG_ROOT,
    path.join(cwd, '..', 'demo-infra')
  ),
  /** True when using the demo-infra test fixture (not a customer root). */
  configRootIsDemoFixture:
    !process.env.GRID_CONFIG_ROOT ||
    process.env.GRID_USE_DEMO === '1' ||
    process.env.GRID_USE_DEMO === 'true',
  /**
   * grid-terraform module bank. Injected to CLI as GRID_MODULE_BANK.
   */
  moduleBank: requiredPath(
    process.env.GRID_MODULE_BANK,
    path.join(cwd, '..', 'grid-terraform')
  ),
  terraformBin: process.env.GRID_TERRAFORM_BIN || 'terraform',
  /** When true, API-triggered applies use -auto-approve */
  autoApprove: process.env.GRID_AUTO_APPROVE !== 'false',
  /** Optional bootstrap GitOps repo (installer can also set via API) */
  gitops: {
    repoUrl: process.env.GRID_GITOPS_REPO_URL || '',
    branch: process.env.GRID_GITOPS_BRANCH || 'main',
    pathPrefix: process.env.GRID_GITOPS_PATH || 'infrastructures',
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

/**
 * Env passed to every CLI child process. Core is the source of truth for paths.
 */
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
