import { describe, expect, it } from 'vitest';
import {
  ensureUnitIdInConfig,
  readExplicitUnitId,
  resolveUnitId,
  unitIdFromGitPath,
} from '../src/services/unitIdentity';

describe('unitIdentity', () => {
  const pathA = 'projects/demo/development/aws/vpc/grid-labs-vpc.json';
  const pathB = 'projects/demo/development/aws/vpc/renamed-vpc.json';

  it('derives a stable UUID v5 from gitPath', () => {
    const a = unitIdFromGitPath(pathA);
    const b = unitIdFromGitPath(pathA);
    expect(a).toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(unitIdFromGitPath(pathB)).not.toBe(a);
  });

  it('prefers metadata.id over path derivation', () => {
    const stamped = '11111111-1111-4111-8111-111111111111';
    const cfg = {
      metadata: { id: stamped, name: 'x' },
      provider: 'aws',
      resources: [],
    };
    expect(resolveUnitId(pathA, cfg)).toBe(stamped);
    expect(resolveUnitId(pathB, cfg)).toBe(stamped);
  });

  it('does not mutate config when id is derived from path', () => {
    const cfg = {
      metadata: { name: 'grid-labs-vpc', environment: 'development' },
      provider: 'aws',
      resources: [{ type: 'vpc', name: 'main' }],
    };
    const first = ensureUnitIdInConfig(pathA, cfg);
    expect(first.stamped).toBe(false);
    expect(readExplicitUnitId(first.cfg)).toBeUndefined();
    expect(first.id).toBe(unitIdFromGitPath(pathA));
    expect(first.cfg).toBe(cfg);
  });

  it('keeps explicit id across path rename', () => {
    const stamped = '22222222-2222-4222-8222-222222222222';
    const cfg = {
      metadata: { id: stamped, name: 'vpc' },
      provider: 'aws',
      resources: [],
    };
    expect(resolveUnitId(pathB, cfg)).toBe(stamped);
  });
});
