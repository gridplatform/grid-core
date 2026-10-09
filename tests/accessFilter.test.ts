import { describe, expect, it } from 'vitest';
import {
  filterEnvironmentsByAccess,
  filterInfrastructuresByAccess,
  filterProjectsByAccess,
} from '../src/services/accessFilter';
import type { EffectiveAccess } from '../src/services/accessService';
import { ACCESS_DOMAIN_CATALOG, NO_ACCESS_DOMAINS } from '../src/auth/rbac';

function memberAccess(): EffectiveAccess {
  return {
    role: 'member',
    domains: { ...NO_ACCESS_DOMAINS, infrastructure: 'read' },
    infrastructure: 'read',
    kubernetes: 'none',
    customWriteAlwaysNeedsApproval: false,
    scope: 'grants',
    workspace: {
      mode: 'grants',
      projects: ['grid-labs'],
      environments: { 'grid-labs': ['development'] },
    },
    canApprove: false,
    canBypassApproval: false,
    canManageUsers: false,
    domainCatalog: ACCESS_DOMAIN_CATALOG,
  };
}

describe('accessFilter list helpers', () => {
  const access = memberAccess();

  it('filters projects by grant', () => {
    const out = filterProjectsByAccess(access, [
      { slug: 'grid-labs', name: 'Grid Labs' },
      { slug: 'demo-app', name: 'Demo' },
    ]);
    expect(out.map((p) => p.slug)).toEqual(['grid-labs']);
  });

  it('filters environments for a project', () => {
    const out = filterEnvironmentsByAccess(
      access,
      [{ slug: 'development' }, { slug: 'production' }],
      'grid-labs'
    );
    expect(out.map((e) => e.slug)).toEqual(['development']);
  });

  it('filters infrastructures by project and environment', () => {
    const out = filterInfrastructuresByAccess(access, [
      { project: 'grid-labs', environment: 'development' },
      { project: 'grid-labs', environment: 'production' },
      { project: 'demo-app', environment: 'development' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      project: 'grid-labs',
      environment: 'development',
    });
  });
});
