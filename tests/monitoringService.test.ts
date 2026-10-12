import { describe, expect, it } from 'vitest';
import {
  healthFromResourceStatus,
  healthFromUpValue,
  resolveUnitHealth,
} from '../src/services/monitoringService';
import type { Infrastructure } from '../src/types/api';

function infra(partial: Partial<Infrastructure> & { id: string; status: Infrastructure['status'] }): Infrastructure {
  return {
    userId: 'u',
    name: 'demo',
    environment: 'development',
    provider: 'AWS',
    configJson: {},
    autoApprove: true,
    driftDetection: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('healthFromResourceStatus', () => {
  it('maps inventory statuses', () => {
    expect(healthFromResourceStatus('running')).toBe('healthy');
    expect(healthFromResourceStatus('pending')).toBe('warning');
    expect(healthFromResourceStatus('error')).toBe('critical');
    expect(healthFromResourceStatus('stopped')).toBe('unknown');
  });
});

describe('healthFromUpValue', () => {
  it('maps prometheus up', () => {
    expect(healthFromUpValue(1)).toBe('healthy');
    expect(healthFromUpValue(0)).toBe('critical');
  });
});

describe('resolveUnitHealth', () => {
  it('uses inventory when prom map is null', () => {
    const r = resolveUnitHealth(infra({ id: 'a', status: 'pending' }), null);
    expect(r.source).toBe('inventory');
    expect(r.status).toBe('warning');
  });

  it('labels-only + no series → inventory (managed / network / …)', () => {
    const r = resolveUnitHealth(
      infra({
        id: 'vpc-1',
        status: 'running',
        name: 'grid-labs-vpc',
        configJson: {
          metadata: { kind: 'vpc' },
          resources: [{ type: 'vpc', name: 'main', role: 'primary' }],
        },
        gitPath: 'projects/demo/development/aws/vpc/grid-labs-vpc.json',
      }),
      new Map()
    );
    expect(r.source).toBe('inventory');
    expect(r.status).toBe('healthy');
    expect(r.message).toMatch(/inventory/i);
    expect(r.message).toMatch(/labels-only/i);
  });

  it('host profile + no series → unknown (expect workload collector)', () => {
    const r = resolveUnitHealth(
      infra({
        id: 'vm-1',
        status: 'running',
        name: 'app-vm',
        configJson: {
          metadata: { kind: 'vm' },
          resources: [{ type: 'vm', name: 'app', role: 'primary' }],
        },
        gitPath: 'projects/demo/development/aws/vm/app-vm.json',
      }),
      new Map()
    );
    expect(r.source).toBe('prometheus');
    expect(r.status).toBe('unknown');
  });

  it('kubernetes profile + no series → unknown', () => {
    const r = resolveUnitHealth(
      infra({
        id: 'eks-1',
        status: 'running',
        name: 'apps',
        configJson: {
          metadata: { kind: 'eks' },
          resources: [{ type: 'eks', name: 'apps', role: 'primary' }],
        },
      }),
      new Map()
    );
    expect(r.source).toBe('prometheus');
    expect(r.status).toBe('unknown');
  });

  it('healthy / critical from up by grid_unit_id', () => {
    const map = new Map([
      ['up-id', 1],
      ['down-id', 0],
    ]);
    expect(resolveUnitHealth(infra({ id: 'up-id', status: 'pending' }), map)).toMatchObject({
      source: 'prometheus',
      status: 'healthy',
    });
    expect(resolveUnitHealth(infra({ id: 'down-id', status: 'running' }), map)).toMatchObject({
      source: 'prometheus',
      status: 'critical',
    });
  });
});
