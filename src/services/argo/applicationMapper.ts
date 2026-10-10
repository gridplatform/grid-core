import type { WorkloadIntent } from './workloadTypes';

export type ArgoApplicationManifest = {
  apiVersion: 'argoproj.io/v1alpha1';
  kind: 'Application';
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    finalizers?: string[];
  };
  spec: Record<string, unknown>;
};

export class WorkloadMapError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 422
  ) {
    super(message);
    this.name = 'WorkloadMapError';
  }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 53) || 'app'
  );
}

/**
 * Map Grid workload intent JSON → Argo CD Application CR.
 * Same CR works for upstream Argo CD and OpenShift GitOps.
 */
export function mapWorkloadToArgoApplication(
  intent: WorkloadIntent,
  opts?: {
    /** Argo / OpenShift GitOps namespace (argocd | openshift-gitops). */
    argoNamespace?: string;
    unitRelPath?: string;
  }
): ArgoApplicationManifest {
  const name = slug(intent.metadata.name);
  if (!name) throw new WorkloadMapError('metadata.name is required');

  const ns = (intent.destination?.namespace || '').trim();
  if (!ns) throw new WorkloadMapError('destination.namespace is required');

  const src = intent.source;
  if (!src?.repoURL?.trim()) {
    throw new WorkloadMapError('source.repoURL is required');
  }

  const argoNamespace = (opts?.argoNamespace || 'argocd').trim() || 'argocd';
  const cluster = intent.cluster || {};
  const destination: Record<string, string> = { namespace: ns };
  if (cluster.name?.trim()) destination.name = cluster.name.trim();
  else destination.server = (cluster.server || 'https://kubernetes.default.svc').trim();

  const source: Record<string, unknown> = {
    repoURL: src.repoURL.trim(),
    targetRevision: (src.targetRevision || 'HEAD').trim(),
  };

  const kind = (intent.kind || '').toLowerCase();
  if (src.helm || kind === 'helm-release') {
    const helm = src.helm || {};
    if (helm.chart?.trim()) {
      source.chart = helm.chart.trim();
      if (helm.repoURL?.trim()) source.repoURL = helm.repoURL.trim();
      if (helm.targetRevision?.trim()) source.targetRevision = helm.targetRevision.trim();
    } else if (src.path?.trim()) {
      source.path = src.path.trim();
    } else {
      throw new WorkloadMapError('Helm source needs chart=… or path=… to a chart directory');
    }
    const helmSpec: Record<string, unknown> = {};
    if (helm.releaseName) helmSpec.releaseName = helm.releaseName;
    if (helm.valueFiles?.length) helmSpec.valueFiles = helm.valueFiles;
    if (helm.parameters?.length) helmSpec.parameters = helm.parameters;
    if (helm.values !== undefined) {
      if (typeof helm.values === 'string') helmSpec.values = helm.values;
      else helmSpec.valuesObject = helm.values;
    }
    if (Object.keys(helmSpec).length) source.helm = helmSpec;
  } else if (src.path?.trim()) {
    source.path = src.path.trim();
    if (src.directory) source.directory = src.directory;
  } else {
    throw new WorkloadMapError('source.path is required for non-Helm directory/kustomize apps');
  }

  const syncPolicy: Record<string, unknown> = {
    syncOptions: ['CreateNamespace=true'],
  };
  if (intent.autoSync) {
    syncPolicy.automated = { prune: true, selfHeal: true };
  }

  const labels: Record<string, string> = {
    'app.kubernetes.io/managed-by': 'grid',
    'gridplatform.org/engine': 'kubernetes',
    'gridplatform.org/environment': (intent.metadata.environment || 'development').toLowerCase(),
  };
  if (intent.metadata.clusterRef) {
    labels['gridplatform.org/cluster-ref'] = slug(intent.metadata.clusterRef);
  }
  if (opts?.unitRelPath) {
    labels['gridplatform.org/unit'] = opts.unitRelPath.replace(/[^a-zA-Z0-9._/-]+/g, '-').slice(0, 63);
  }

  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: {
      name,
      namespace: argoNamespace,
      labels,
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: (intent.project || 'default').trim() || 'default',
      source,
      destination,
      syncPolicy,
    },
  };
}

export function applicationManifestToYaml(app: ArgoApplicationManifest): string {
  // Minimal YAML emitter (stable key order for diffs in tests / Git).
  return [
    'apiVersion: argoproj.io/v1alpha1',
    'kind: Application',
    'metadata:',
    `  name: ${app.metadata.name}`,
    `  namespace: ${app.metadata.namespace}`,
    '  labels:',
    ...Object.entries(app.metadata.labels || {}).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`),
    '  finalizers:',
    ...(app.metadata.finalizers || []).map((f) => `    - ${f}`),
    'spec:',
    yamlValue('  ', app.spec),
    '',
  ].join('\n');
}

function yamlValue(indent: string, value: unknown): string {
  if (value === null || value === undefined) return `${indent}null`;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${indent}${JSON.stringify(value)}`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}[]`;
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const body = yamlValue(`${indent}  `, item);
          return `${indent}-\n${body}`;
        }
        return `${indent}- ${JSON.stringify(item)}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        if (v !== null && typeof v === 'object') {
          return `${indent}${k}:\n${yamlValue(`${indent}  `, v)}`;
        }
        return `${indent}${k}: ${JSON.stringify(v)}`;
      })
      .join('\n');
  }
  return `${indent}${JSON.stringify(value)}`;
}
