import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  accessAtLeast,
  canApproveReleases,
  canBypassApproval,
  canManageUsers,
  grantDomainsForContext,
  mergeDomainMaps,
  normalizeGrant,
  permissionsForRole,
  scopeMatches,
} from '../src/auth/rbac';
import { isReleaseModuleBankRef } from '../src/validateProduction';

describe('rbac roles', () => {
  it('lists assignable roles without superadmin', () => {
    expect(ASSIGNABLE_ROLES).toContain('member');
    expect(ASSIGNABLE_ROLES).toContain('admin');
    expect(ASSIGNABLE_ROLES).not.toContain('superadmin');
  });

  it('gates user management and approval correctly', () => {
    expect(canManageUsers('admin')).toBe(true);
    expect(canManageUsers('superadmin')).toBe(true);
    expect(canManageUsers('maintainer')).toBe(false);
    expect(canManageUsers('member')).toBe(false);

    expect(canApproveReleases('maintainer')).toBe(true);
    expect(canApproveReleases('developer')).toBe(false);

    expect(canBypassApproval('superadmin')).toBe(true);
    expect(canBypassApproval('admin')).toBe(false);
  });

  it('gives global write domains to built-in roles and none to member', () => {
    const admin = permissionsForRole('admin');
    expect(admin.scope).toBe('global');
    expect(admin.domains.infrastructure).toBe('write');

    const member = permissionsForRole('member');
    expect(member.scope).toBe('grants');
    expect(member.domains.infrastructure).toBe('none');
  });
});

describe('rbac grant matching', () => {
  it('matches wildcards and concrete slugs', () => {
    expect(scopeMatches(['*'], 'grid-labs')).toBe(true);
    expect(scopeMatches(['grid-labs'], 'grid-labs')).toBe(true);
    expect(scopeMatches(['grid-labs'], 'demo-app')).toBe(false);
    expect(scopeMatches(['development'], undefined)).toBe(false);
  });

  it('returns domains only when project and env match', () => {
    const grant = normalizeGrant({
      projects: ['Grid-Labs'],
      environments: ['Development'],
      domains: { infrastructure: 'write', monitoring: 'read' },
    });
    expect(grant.projects).toEqual(['grid-labs']);
    expect(grant.environments).toEqual(['development']);

    expect(grantDomainsForContext(grant, 'grid-labs', 'development')?.infrastructure).toBe(
      'write'
    );
    expect(grantDomainsForContext(grant, 'demo-app', 'development')).toBeNull();
    expect(grantDomainsForContext(grant, 'grid-labs', 'production')).toBeNull();
  });

  it('merges domain maps with max level', () => {
    const merged = mergeDomainMaps(
      { infrastructure: 'read', monitoring: 'none' },
      { infrastructure: 'write', apm: 'read' }
    );
    expect(merged.infrastructure).toBe('write');
    expect(merged.monitoring).toBe('none');
    expect(merged.apm).toBe('read');
  });

  it('ranks access levels', () => {
    expect(accessAtLeast('write', 'read')).toBe(true);
    expect(accessAtLeast('read', 'write')).toBe(false);
    expect(accessAtLeast('none', 'read')).toBe(false);
  });
});

describe('module bank refs', () => {
  it('accepts release tags only', () => {
    expect(isReleaseModuleBankRef('v0.1.0')).toBe(true);
    expect(isReleaseModuleBankRef('v1.2.3-lts')).toBe(true);
    expect(isReleaseModuleBankRef('main')).toBe(false);
    expect(isReleaseModuleBankRef(undefined)).toBe(false);
  });
});
