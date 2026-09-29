/**
 * GitOps: desired-state JSON lives in the installer's Git repo.
 * Grid syncs that repo, detects commits that differ from last apply,
 * and reports drift (desired JSON vs Terraform state / live).
 */

export type GitOpsSyncStatus = 'idle' | 'syncing' | 'error' | 'ok';

export interface GitOpsSettings {
  /** HTTPS or SSH clone URL of the customer's desired-state repo */
  repoUrl: string;
  branch: string;
  /**
   * Path inside the repo that contains infrastructure folders, e.g. "infrastructures"
   * Expected layout:
   *   infrastructures/<name>/grid.json
   */
  pathPrefix: string;
  /** Optional poll interval in seconds (0 = manual sync only) */
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
  /**
   * true when terraform plan reports changes (desired JSON ≠ state/live)
   */
  hasDrift: boolean;
  /**
   * true when synced Git content differs from last-applied content hash
   */
  gitChangedSinceApply: boolean;
  summary: string;
  /** Human lines from terraform plan / state */
  changes: string[];
  planExcerpt?: string;
  /**
   * Guidance for the operator
   */
  actions: {
    /** Make live match Git desired state */
    applyGitDesired: string;
    /** Keep live; update Git JSON instead (manual / future reverse-map) */
    updateGitToMatchLive: string;
  };
  checkedAt: string;
}

export interface GitOpsFileRecord {
  /** Relative path in repo, e.g. infrastructures/prod-vpc/grid.json */
  gitPath: string;
  contentHash: string;
  commit?: string;
}
