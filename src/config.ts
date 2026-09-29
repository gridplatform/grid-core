import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function requiredPath(envValue: string | undefined, fallback: string): string {
  return path.resolve(envValue || fallback);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: requiredPath(process.env.GRID_DATA_DIR, path.join(process.cwd(), 'data')),
  /** Directory where terraform workspaces are written */
  workDir: requiredPath(process.env.GRID_WORK_DIR, path.join(process.cwd(), 'workspaces')),
  /**
   * Path to grid-cli package root (must contain templates/ and built or tsx-runnable src).
   * Default: sibling ../grid-cli
   */
  cliRoot: requiredPath(
    process.env.GRID_CLI_ROOT,
    path.join(process.cwd(), '..', 'grid-cli')
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
