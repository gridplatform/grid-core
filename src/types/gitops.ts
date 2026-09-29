/**
 * GitOps: desired-state JSON in the installer's Git repo.
 * Sync upserts records; drift compares desired JSON to Terraform state/live.
 */

export type GitOpsSyncStatus = 'idle' | 'syncing' | 'error' | 'ok';

export interface GitOpsSettings {
  /** HTTPS or SSH clone URL of the desired-state repo */
  repoUrl: string;
  branch: string;
  /**
   * Optional path prefix inside the repo (empty = repo root).
   * Layout: <cloud>/<env>/<type>/<name>.json plus archive/.
   */
  pathPrefix: string;
  /** Poll interval in seconds (0 = manual sync only) */
  syncIntervalSec: number;
  enabled: boolean;
  updatedAt: string;
}

export interface GitOpsRuntimeStatus {
  settings: GitOpsSettings | null;
  syncStatus: GitOpsSyncStatus;
  lastSyncAt?: string;
  lastSyncError?: string;
  lastCommit?: string;
  lastCommitMessage?: string;
  clonePath?: string;
  trackedCount: number;
}

export type DriftKind =
  | 'in_sync'
  | 'desired_ahead'
  | 'live_drift'
  | 'unknown'
  | 'no_state';

export interface DriftReport {
  infrastructureId: string;
  kind: DriftKind;
  /** True when terraform plan reports changes (desired ≠ state/live) */
  hasDrift: boolean;
  /** True when synced Git content differs from last-applied hash */
  gitChangedSinceApply: boolean;
  summary: string;
  /** Human lines from terraform plan / state */
  changes: string[];
  planExcerpt?: string;
  /** Operator guidance */
  actions: {
    /** Make live match Git desired state */
    applyGitDesired: string;
    /** Keep live; update Git JSON by hand */
    updateGitToMatchLive: string;
  };
  checkedAt: string;
}

export interface GitOpsFileRecord {
  /** Relative path in repo, e.g. aws/development/vpc/demo-vpc.json */
  gitPath: string;
  contentHash: string;
  commit?: string;
}
