import { describe, expect, it } from 'vitest';
import { inferCollectorProfile } from '../src/services/monitoring/collectorConfigService';
import {
  alloyRelabelRules,
  buildUnitMetricLabels,
} from '../src/services/monitoring/collectorLabels';

describe('inferCollectorProfile', () => {
  it('classifies host units structurally', () => {
    expect(inferCollectorProfile('vm')).toBe('host');
    expect(inferCollectorProfile('ec2-instance')).toBe('host');
    expect(inferCollectorProfile('virtual-machine')).toBe('host');
  });

  it('classifies kubernetes units structurally', () => {
    expect(inferCollectorProfile('eks')).toBe('kubernetes');
    expect(inferCollectorProfile('gke-node-pool')).toBe('kubernetes');
    expect(inferCollectorProfile('kubernetes')).toBe('kubernetes');
  });

  it('defaults other kinds to labels-only', () => {
    expect(inferCollectorProfile('s3-bucket')).toBe('labels-only');
    expect(inferCollectorProfile('vpc')).toBe('labels-only');
  });
});

describe('unit metric labels', () => {
  it('builds join key and optional stamps', () => {
    const labels = buildUnitMetricLabels({
      unitId: 'unit-1',
      name: 'api',
      project: 'demo',
      environment: 'development',
      provider: 'Alibaba',
      resourceType: 'vm',
    });
    expect(labels.grid_unit_id).toBe('unit-1');
    expect(labels.provider).toBe('alibaba');
    expect(labels.resource_type).toBe('vm');
    expect(alloyRelabelRules(labels)).toContain('grid_unit_id');
    expect(alloyRelabelRules(labels)).toContain('unit-1');
  });
});
