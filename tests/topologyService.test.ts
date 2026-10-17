import { describe, expect, it } from 'vitest';
import type { Infrastructure } from '../src/types/api';
import {
  buildTopologyFromInfrastructures,
  layerForResourceType,
} from '../src/services/topologyService';

function infra(
  partial: Pick<Infrastructure, 'id' | 'name' | 'provider' | 'configJson'> &
    Partial<Pick<Infrastructure, 'gitPath'>>
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

    expect(provider.vpcs.map((v) => v.resourceType)).toEqual(['vpc', 'gce']);
    const network = provider.vpcs[0];
    expect(network.resources.map((r) => r.type)).toEqual(['vpc', 'subnet']);
    expect(network.resources.map((r) => r.layer)).toEqual(['network', 'network']);
    expect(network.cidr).toBe('10.0.0.0/16');
    expect(provider.vpcs[1].resources[0]).toMatchObject({
      type: 'gce',
      layer: 'application',
    });
    expect(provider.vpcs[1].cidr).toBe('');
  });
});
