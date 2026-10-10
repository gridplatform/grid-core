/**
 * Desired-state shape for Kubernetes workloads (GitOps via Argo CD).
 * Cluster / node-pool units stay Terraform; workloads never embed in cluster JSON.
 */

export type WorkloadSourceKind = 'helm' | 'kustomize' | 'directory' | 'plugin';

export interface WorkloadClusterRef {
  /** Argo cluster name (registered in Argo) or "in-cluster". */
  name?: string;
  /** API server URL when not using name (e.g. https://kubernetes.default.svc). */
  server?: string;
}

export interface WorkloadHelmSource {
  chart?: string;
  repoURL?: string;
  targetRevision?: string;
  releaseName?: string;
  values?: Record<string, unknown> | string;
  valueFiles?: string[];
  parameters?: Array<{ name: string; value: string }>;
}

export interface WorkloadGitSource {
  repoURL: string;
  path?: string;
  targetRevision?: string;
  helm?: WorkloadHelmSource;
  directory?: { recurse?: boolean; include?: string; exclude?: string };
}

export interface WorkloadIntent {
  metadata: {
    name: string;
    environment?: string;
    project?: string;
    /** Terraform cluster unit name / id this app deploys into. */
    clusterRef?: string;
    id?: string;
  };
  /** Always kubernetes for workload units. */
  engine: 'kubernetes';
  /**
   * UI / catalog kind: workload | helm-release | kustomize | cronjob | job | config
   * Drives defaults; source block is authoritative for Argo.
   */
  kind?: string;
  destination: {
    namespace: string;
  };
  cluster?: WorkloadClusterRef;
  source: WorkloadGitSource;
  /**
   * When true, Argo auto-syncs (lab). Default false — Grid Releases trigger sync
   * so approval gates stay in Grid.
   */
  autoSync?: boolean;
  project?: string;
}

export function isWorkloadIntent(cfg: unknown): cfg is WorkloadIntent {
  if (!cfg || typeof cfg !== 'object') return false;
  const c = cfg as Record<string, unknown>;
  if (c.engine !== 'kubernetes') return false;
  if (!c.metadata || typeof c.metadata !== 'object') return false;
  if (!c.source || typeof c.source !== 'object') return false;
  if (!c.destination || typeof c.destination !== 'object') return false;
  return true;
}
