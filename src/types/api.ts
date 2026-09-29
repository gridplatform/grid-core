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
export type CloudProviderType = 'AWS' | 'GCP' | 'Azure' | 'On-Prem';

export type InfrastructureType =
  | 'single-vm'
  | 'vm-cluster'
  | 'k8s-deployment'
  | 'k8s-service'
  | 'k8s-ingress'
  | 'k8s-cronjob'
  | 'k8s-statefulset'
  | 'k8s-daemonset'
  | 'k8s-storage'
  | 'managed-service'
  | 'network'
  | 'gpu-node'
  | 'gpu-pool';

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
  connections: string[];
  cluster?: string;
  config?: Record<string, unknown>;
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
  isProduction: boolean;
  approvalRequired: boolean;
  createdAt: string;
  updatedAt: string;
}
