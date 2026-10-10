import { describe, expect, it } from 'vitest';
import {
  applicationManifestToYaml,
  mapWorkloadToArgoApplication,
  WorkloadMapError,
} from '../src/services/argo/applicationMapper';
import type { WorkloadIntent } from '../src/services/argo/workloadTypes';
import { isWorkloadIntent } from '../src/services/argo/workloadTypes';

const baseIntent = (): WorkloadIntent => ({
  engine: 'kubernetes',
  kind: 'workload',
  metadata: { name: 'Demo API', environment: 'development', clusterRef: 'eks-main' },
  destination: { namespace: 'demo' },
  source: {
    repoURL: 'https://github.com/example/gitops.git',
    path: 'apps/demo-api',
    targetRevision: 'main',
  },
});

describe('isWorkloadIntent', () => {
  it('accepts a valid intent', () => {
    expect(isWorkloadIntent(baseIntent())).toBe(true);
  });

  it('rejects terraform-shaped configs', () => {
    expect(
      isWorkloadIntent({
        provider: 'aws',
        resources: [{ type: 'vpc', name: 'x' }],
      })
    ).toBe(false);
  });
});

describe('mapWorkloadToArgoApplication', () => {
  it('maps directory source to Application CR', () => {
    const app = mapWorkloadToArgoApplication(baseIntent(), {
      argoNamespace: 'argocd',
      unitRelPath: 'workloads/demo/development/demo-api',
    });
    expect(app.apiVersion).toBe('argoproj.io/v1alpha1');
    expect(app.kind).toBe('Application');
    expect(app.metadata.name).toBe('demo-api');
    expect(app.metadata.namespace).toBe('argocd');
    expect(app.spec.destination).toEqual({
      namespace: 'demo',
      server: 'https://kubernetes.default.svc',
    });
    expect(app.spec.source).toMatchObject({
      repoURL: 'https://github.com/example/gitops.git',
      path: 'apps/demo-api',
      targetRevision: 'main',
    });
    expect((app.spec.syncPolicy as { automated?: unknown }).automated).toBeUndefined();
  });

  it('maps helm chart source', () => {
    const intent = baseIntent();
    intent.kind = 'helm-release';
    intent.source = {
      repoURL: 'https://charts.example.com',
      helm: {
        chart: 'nginx',
        targetRevision: '1.2.3',
        releaseName: 'web',
        values: { replicaCount: 2 },
      },
    };
    const app = mapWorkloadToArgoApplication(intent, { argoNamespace: 'openshift-gitops' });
    expect(app.metadata.namespace).toBe('openshift-gitops');
    expect(app.spec.source).toMatchObject({
      chart: 'nginx',
      targetRevision: '1.2.3',
      helm: { releaseName: 'web', valuesObject: { replicaCount: 2 } },
    });
  });

  it('enables automated sync when autoSync is true', () => {
    const intent = { ...baseIntent(), autoSync: true };
    const app = mapWorkloadToArgoApplication(intent);
    expect((app.spec.syncPolicy as { automated: { prune: boolean } }).automated.prune).toBe(
      true
    );
  });

  it('requires destination.namespace', () => {
    const intent = baseIntent();
    intent.destination.namespace = '';
    expect(() => mapWorkloadToArgoApplication(intent)).toThrow(WorkloadMapError);
  });

  it('emits stable YAML', () => {
    const yaml = applicationManifestToYaml(
      mapWorkloadToArgoApplication(baseIntent(), { argoNamespace: 'argocd' })
    );
    expect(yaml).toContain('apiVersion: argoproj.io/v1alpha1');
    expect(yaml).toContain('kind: Application');
    expect(yaml).toContain('name: demo-api');
    expect(yaml).toContain('gridplatform.org/engine');
  });
});
