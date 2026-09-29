/**
 * Types aligned with Grid Console (grid-ui) API contract.
 * Keep in sync with grid-ui/src/types/api.ts.
 */

export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';
export type ResourceStatus =
  | 'running'
  | 'stopped'
  | 'error'
  | 'degraded'
  | 'pending'
  | 'destroyed'
  /** Desired-state JSON removed from Git; awaiting explicit destroy */
  | 'stale';
export type DeploymentStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled';
export type LifecycleMode = 'plan' | 'apply' | 'destroy';
export type CloudProviderType = string;

/** Catalog / module resource type (e.g. alb, vpc, access-analyzer). */
export type InfrastructureType = string;

export interface Infrastructure {
  id: string;
  userId: string;
  name: string;
  environment: string;
  provider: CloudProviderType;
  configJson: Record<string, unknown>;
  gitRepo?: string;
  gitBranch?: string;
  /** Path of desired-state file in the GitOps repo */
  gitPath?: string;
  /** Project slug (from projects/<slug>/…) */
  project?: string;
  /** SHA of last synced commit for this file */
  gitCommit?: string;
  /** Hash of configJson last synced from Git */
  gitContentHash?: string;
  /** Hash of configJson last successfully applied */
  lastAppliedHash?: string;
  status: ResourceStatus;
  autoApprove: boolean;
  driftDetection: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InfrastructureListItem {
  id: string;
  name: string;
  type: InfrastructureType;
  status: ResourceStatus;
  region: string;
  ip?: string;
  cpu?: string;
  memory?: string;
  environment: string;
  provider: CloudProviderType;
  project?: string;
  connections: string[];
  cluster?: string;
  config?: Record<string, unknown>;
  gitPath?: string;
}

export interface Deployment {
  id: string;
  infrastructureId: string;
  status: DeploymentStatus;
  /** Lifecycle step for this run */
  mode?: LifecycleMode;
  progress?: number;
  startedAt: string;
  completedAt?: string;
  logs: string[];
  /** Terraform plan output / summary */
  planSummary?: string;
  triggeredBy: string;
  gitCommit?: string;
  gitBranch?: string;
  name?: string;
  engine?: string;
  resourceType?: string;
  provider?: string;
  environment?: string;
}

export interface TopologyResource {
  id: string;
  name: string;
  type: string;
  layer: string;
  status: HealthStatus;
  connections: string[];
  meta?: Record<string, string>;
}

export interface TopologyVpc {
  id: string;
  name: string;
  region: string;
  cidr: string;
  providerId: string;
  resources: TopologyResource[];
  vpcConnections: [];
  totalResources: number;
  healthCounts: { healthy: number; warning: number; critical: number };
  status: HealthStatus;
}

export interface TopologyProvider {
  id: string;
  name: string;
  type: CloudProviderType;
  vpcs: TopologyVpc[];
  totalResources: number;
  healthCounts: { healthy: number; warning: number; critical: number };
}

export type ReleaseStatus =
  | 'queued'
  | 'pending_approval'
  | 'approved'
  | 'deploying'
  | 'success'
  | 'failed'
  | 'rolled_back';

export type ReleaseType = 'terraform' | 'kubernetes' | 'custom';

/** How the release converges desired state */
export type ReleaseMode = 'plan' | 'apply' | 'destroy' | 'custom';

export interface Release {
  id: string;
  name: string;
  type: ReleaseType;
  status: ReleaseStatus;
  environment: string;
  /** plan = dry-run, apply = live, custom = grid CLI backdoor */
  mode: ReleaseMode;
  infrastructureId?: string;
  infrastructureName?: string;
  customCommand?: string;
  deploymentId?: string;
  version?: string;
  gitCommit?: string;
  gitBranch?: string;
  logs: string[];
  message?: string;
  createdAt: string;
  deployedAt?: string;
  completedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  rollbackFrom?: string;
  createdBy: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'developer' | 'maintainer' | 'admin';
  avatarUrl?: string;
  createdAt: string;
}

export interface Environment {
  id: string;
  name: string;
  slug: string;
  order: number;
  kind?: 'canonical' | 'ephemeral';
  isProduction: boolean;
  approvalRequired: boolean;
  baseEnv?: string;
  ttl?: string;
  expiresAt?: string;
  expired?: boolean;
  unitCount?: number;
  createdAt: string;
  updatedAt: string;
}
