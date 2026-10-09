import { describe, expect, it } from 'vitest';
import {
  DeployMapError,
  mapDeployRequestToGridConfig,
} from '../src/services/gridConfigMapper';

describe('mapDeployRequestToGridConfig', () => {
  it('rejects kubernetes engine', () => {
    expect(() =>
      mapDeployRequestToGridConfig({
        name: 'app',
        engine: 'kubernetes',
        environment: 'dev',
        resourceType: 'workload',
        config: {},
      })
    ).toThrow(DeployMapError);
  });

  it('passes through explicit resources arrays', () => {
    const mapped = mapDeployRequestToGridConfig({
      name: 'demo',
      engine: 'terraform',
      provider: 'aws',
      environment: 'staging',
      resourceType: 'vpc',
      config: {
        project: 'labs',
        region: 'us-east-1',
        resources: [{ type: 'vpc', name: 'main' }],
      },
    });
    expect(mapped.displayProvider).toBe('AWS');
    expect(mapped.gridConfig.resources).toEqual([{ type: 'vpc', name: 'main' }]);
    expect((mapped.gridConfig.metadata as { environment: string }).environment).toBe(
      'staging'
    );
  });

  it('composes network types into vpc + subnet resources', () => {
    const mapped = mapDeployRequestToGridConfig({
      name: 'Edge Net',
      engine: 'terraform',
      provider: 'aws',
      environment: 'development',
      resourceType: 'vpc',
      config: { region: 'ap-south-1', cidr: '10.50.0.0/16' },
    });
    const resources = mapped.gridConfig.resources as Array<{ type: string }>;
    expect(resources.some((r) => r.type === 'vpc')).toBe(true);
    expect(resources.some((r) => r.type === 'subnet')).toBe(true);
  });

  it('maps generic module types to a single resource', () => {
    const mapped = mapDeployRequestToGridConfig({
      name: 'My Bucket',
      engine: 'terraform',
      provider: 'aws',
      environment: 'dev',
      resourceType: 's3-bucket',
      config: { region: 'us-east-1', versioning: true },
    });
    const resources = mapped.gridConfig.resources as Array<Record<string, unknown>>;
    expect(resources).toHaveLength(1);
    expect(resources[0].type).toBe('s3-bucket');
    expect(resources[0].versioning).toBe(true);
  });
});
