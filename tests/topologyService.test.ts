import { describe, expect, it } from 'vitest';
import type { Infrastructure } from '../src/types/api';
import {
  buildTopologyFromInfrastructures,
  layerForResourceType,
} from '../src/services/topologyService';

function infra(
  partial: Pick<Infrastructure, 'id' | 'name' | 'provider' | 'configJson'> &
    Partial<Pick<Infrastructure, 'gitPath' | 'environment'>>
): Infrastructure {
  return {
    userId: 'u',
    environment: 'production',
    status: 'running',
    autoApprove: false,
    driftDetection: false,
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

describe('layerForResourceType', () => {
  it('places catalog types on rings without renaming them', () => {
    expect(layerForResourceType('vpc')).toBe('network');
    expect(layerForResourceType('subnet')).toBe('network');
    expect(layerForResourceType('alb')).toBe('loadbalancer');
    expect(layerForResourceType('waf')).toBe('waf');
    expect(layerForResourceType('gke')).toBe('application');
    expect(layerForResourceType('cloud-sql')).toBe('data');
    expect(layerForResourceType('ec2')).toBe('application');
    expect(layerForResourceType('cloud-nat')).toBe('network');
    expect(layerForResourceType('network')).toBe('network');
    expect(layerForResourceType('vnet-peering')).toBe('network');
    expect(layerForResourceType('front-door')).toBe('loadbalancer');
    expect(layerForResourceType('lb-http')).toBe('loadbalancer');
    expect(layerForResourceType('oss')).toBe('data');
    expect(layerForResourceType('cosmosdb')).toBe('data');
    expect(layerForResourceType('cloud-guard')).toBe('waf');
    expect(layerForResourceType('natural-language')).toBe('ai-ml');
    expect(layerForResourceType('sagemaker')).toBe('ai-ml');
    expect(layerForResourceType('vertex-ai')).toBe('ai-ml');
    expect(layerForResourceType('azure-openai')).toBe('ai-ml');
    expect(layerForResourceType('modelarts')).toBe('ai-ml');
    expect(layerForResourceType('vllm')).toBe('ai-ml');
    expect(layerForResourceType('cloudwatch')).toBe('observability');
    expect(layerForResourceType('xray')).toBe('observability');
    expect(layerForResourceType('cloud-logging')).toBe('observability');
    expect(layerForResourceType('sysdig')).toBe('observability');
    expect(layerForResourceType('keypair')).toBe('application');
    expect(layerForResourceType('ssh-keypair')).toBe('application');
    expect(layerForResourceType('devops')).toBe('application');
    expect(layerForResourceType('gpu-instance')).toBe('application');
    expect(layerForResourceType('cloudtrail')).toBe('application');
    expect(layerForResourceType('eks')).toBe('application');
  });
});

describe('buildTopologyFromInfrastructures', () => {
  it('keeps each unit type and does not rewrite resources into a fake VPC', () => {
    const [provider] = buildTopologyFromInfrastructures([
      infra({
        id: 'net',
        name: 'edge',
        provider: 'gcp',
        configJson: {
          region: 'us-central1',
          metadata: { kind: 'vpc' },
          resources: [
            { type: 'vpc', name: 'edge', cidr: '10.0.0.0/16' },
            { type: 'subnet', name: 'app' },
          ],
        },
      }),
      infra({
        id: 'vm',
        name: 'api',
        provider: 'gcp',
        gitPath: 'projects/app/gcp/production/gce/api.json',
        configJson: {
          resources: [{ type: 'gce', name: 'api' }],
        },
      }),
    ]);

    expect(provider.environments).toHaveLength(1);
    expect(provider.environments[0].name).toBe('production');
    expect(provider.environments[0].resources.map((r) => r.type)).toEqual([
      'vpc',
      'subnet',
      'gce',
    ]);
    expect(provider.environments[0].resources.map((r) => r.layer)).toEqual([
      'network',
      'network',
      'application',
    ]);
  });

  it('draws one circle per environment and does not drop the other environments', () => {
    const [provider] = buildTopologyFromInfrastructures([
      infra({
        id: 'dev-net',
        name: 'edge',
        provider: 'aws',
        environment: 'development',
        configJson: { resources: [{ type: 'vpc', name: 'edge' }] },
      }),
      infra({
        id: 'prod-vm',
        name: 'api',
        provider: 'aws',
        environment: 'production',
        configJson: { resources: [{ type: 'ec2', name: 'api' }] },
      }),
    ]);

    expect(provider.environments.map((v) => v.name)).toEqual(['development', 'production']);
    expect(provider.environments.map((v) => v.id)).toEqual([
      'env-provider-aws-development',
      'env-provider-aws-production',
    ]);
  });

  it('connects environments when a peering unit depends on another environment', () => {
    const [provider] = buildTopologyFromInfrastructures([
      infra({
        id: 'dev-net',
        name: 'edge',
        provider: 'aws',
        environment: 'development',
        configJson: { resources: [{ type: 'vpc', name: 'edge' }] },
      }),
      infra({
        id: 'prod-net',
        name: 'edge',
        provider: 'aws',
        environment: 'production',
        configJson: { resources: [{ type: 'vpc', name: 'edge' }] },
      }),
      infra({
        id: 'peer',
        name: 'link',
        provider: 'aws',
        environment: 'development',
        configJson: {
          metadata: {
            kind: 'peering',
            dependsOn: ['aws/production/vpc/example-vpc.json'],
          },
          resources: [{ type: 'peering', name: 'link' }],
        },
      }),
    ]);

    const development = provider.environments.find((v) => v.name === 'development');
    expect(development?.connections).toEqual([
      {
        targetId: 'env-provider-aws-production',
        type: 'peering',
        label: 'peering',
      },
    ]);
    expect(provider.environments.find((v) => v.name === 'production')?.connections).toEqual([]);
  });

  it('keeps a circle for every provider, not only one cloud', () => {
    const providers = buildTopologyFromInfrastructures([
      infra({
        id: 'aws-net',
        name: 'edge',
        provider: 'aws',
        environment: 'production',
        configJson: { resources: [{ type: 'vpc', name: 'edge' }] },
      }),
      infra({
        id: 'gcp-net',
        name: 'edge',
        provider: 'gcp',
        environment: 'production',
        configJson: { resources: [{ type: 'network', name: 'edge' }] },
      }),
      infra({
        id: 'azure-db',
        name: 'app',
        provider: 'azure',
        environment: 'staging',
        configJson: { resources: [{ type: 'cosmosdb', name: 'app' }] },
      }),
    ]);

    expect(providers.map((p) => p.type).sort()).toEqual(['aws', 'azure', 'gcp']);
    const gcp = providers.find((p) => p.type === 'gcp');
    expect(gcp?.environments[0].resources.map((r) => r.layer)).toEqual(['network']);
    const azure = providers.find((p) => p.type === 'azure');
    expect(azure?.environments[0].name).toBe('staging');
    expect(azure?.environments[0].resources.map((r) => r.layer)).toEqual(['data']);
  });
});
