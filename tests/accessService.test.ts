import { describe, expect, it } from 'vitest';
import {
  assertDomainAccess,
  canAccessEnvironment,
  canAccessProject,
  canAccessWorkspacePair,
  workspaceFromGrants,
  type EffectiveAccess,
  type WorkspaceAccess,
} from '../src/services/accessService';
import { AccessError } from '../src/lib/httpError';
import { ACCESS_DOMAIN_CATALOG, NO_ACCESS_DOMAINS } from '../src/auth/rbac';

function grantWorkspace(): WorkspaceAccess {
  return workspaceFromGrants([
    {
      projects: ['grid-labs'],
      environments: ['development'],
      domains: {
        ...NO_ACCESS_DOMAINS,
        infrastructure: 'write',
        monitoring: 'read',
      },
    },
  ]);
}

function accessWith(workspace: WorkspaceAccess, domains = NO_ACCESS_DOMAINS): EffectiveAccess {
  return {
    role: 'member',
    domains,
    infrastructure: domains.infrastructure || 'none',
    kubernetes: domains.kubernetes || 'none',
    customWriteAlwaysNeedsApproval: false,
    scope: 'grants',
    workspace,
    canApprove: false,
    canBypassApproval: false,
    canManageUsers: false,
    domainCatalog: ACCESS_DOMAIN_CATALOG,
  };
}

describe('workspaceFromGrants', () => {
  it('builds scoped project and environment visibility', () => {
    const ws = grantWorkspace();
    expect(ws.mode).toBe('grants');
    expect(ws.projects).toEqual(['grid-labs']);
    expect(ws.environments['grid-labs']).toEqual(['development']);
  });

  it('supports wildcard projects and environments', () => {
    const ws = workspaceFromGrants([
      {
        projects: ['*'],
        environments: ['staging'],
        domains: { infrastructure: 'read' },
      },
    ]);
    expect(ws.projects).toEqual(['*']);
    expect(ws.environments['*']).toEqual(['staging']);
  });

  it('unions multiple grants for the same project', () => {
    const ws = workspaceFromGrants([
      {
        projects: ['demo-app'],
        environments: ['development'],
        domains: { infrastructure: 'read' },
      },
      {
        projects: ['demo-app'],
        environments: ['staging'],
        domains: { infrastructure: 'read' },
      },
    ]);
    expect(ws.projects).toEqual(['demo-app']);
    expect(ws.environments['demo-app']?.sort()).toEqual(['development', 'staging']);
  });
});

describe('workspace access helpers', () => {
  const ws = grantWorkspace();

  it('allows only granted project/env pairs', () => {
    expect(canAccessProject(ws, 'grid-labs')).toBe(true);
    expect(canAccessProject(ws, 'demo-app')).toBe(false);
    expect(canAccessEnvironment(ws, 'grid-labs', 'development')).toBe(true);
    expect(canAccessEnvironment(ws, 'grid-labs', 'production')).toBe(false);
    expect(canAccessWorkspacePair(ws, 'grid-labs', 'development')).toBe(true);
    expect(canAccessWorkspacePair(ws, 'demo-app', 'development')).toBe(false);
  });

  it('treats global workspace as open', () => {
    const global: WorkspaceAccess = {
      mode: 'global',
      projects: ['*'],
      environments: { '*': ['*'] },
    };
    expect(canAccessProject(global, 'anything')).toBe(true);
    expect(canAccessEnvironment(global, 'anything', 'production')).toBe(true);
  });
});

describe('assertDomainAccess', () => {
  it('throws AccessError when workspace pair is denied', () => {
    const access = accessWith(grantWorkspace(), {
      ...NO_ACCESS_DOMAINS,
      infrastructure: 'write',
    });
    expect(() =>
      assertDomainAccess(access, 'infrastructure', 'read', 'plan release', {
        project: 'demo-app',
        environment: 'development',
      })
    ).toThrow(AccessError);
  });

  it('throws AccessError when domain level is too low', () => {
    const access = accessWith(grantWorkspace(), {
      ...NO_ACCESS_DOMAINS,
      infrastructure: 'read',
    });
    expect(() =>
      assertDomainAccess(access, 'infrastructure', 'write', 'apply release', {
        project: 'grid-labs',
        environment: 'development',
      })
    ).toThrow(/Insufficient infrastructure/);
  });

  it('passes when workspace and domain level are sufficient', () => {
    const access = accessWith(grantWorkspace(), {
      ...NO_ACCESS_DOMAINS,
      infrastructure: 'write',
    });
    expect(() =>
      assertDomainAccess(access, 'infrastructure', 'write', 'apply release', {
        project: 'grid-labs',
        environment: 'development',
      })
    ).not.toThrow();
  });
});
