import {
  ACCESS_DOMAIN_CATALOG,
  accessAtLeast,
  canApproveReleases,
  canBypassApproval,
  canManageUsers,
  domainLevel,
  grantDomainsForContext,
  mergeDomainMaps,
  permissionsForRole,
  type AccessLevel,
  type AccessDomain,
  type DomainPermissionMap,
  type GroupAccessGrant,
  type UserRole,
} from '../auth/rbac';
import { AccessError } from '../lib/httpError';
import { ensureDefaultGroups, listGroups } from '../store/groupStore';
import { findUserByEmail, findUserById } from '../store/userStore';
import { config } from '../config';

export interface AccessContext {
  project?: string;
  environment?: string;
}

/**
 * Workspace visibility derived from role + custom group grants.
 * - global: every project / environment
 * - grants: only the project×env pairs listed on custom groups
 */
export interface WorkspaceAccess {
  mode: 'global' | 'grants';
  /** `['*']` or concrete project slugs (lowercase). */
  projects: string[];
  /**
   * Environments allowed for a project slug.
   * Key `*` = grant that applies to all projects.
   * Value `['*']` = all environments under that project key.
   */
  environments: Record<string, string[]>;
}

export interface EffectiveAccess {
  role: UserRole;
  /** Effective domain map for the requested project×environment (or global role max). */
  domains: DomainPermissionMap;
  /** Convenience aliases (same as domains.infrastructure / domains.kubernetes). */
  infrastructure: AccessLevel;
  kubernetes: AccessLevel;
  /**
   * True when write for this context comes from a custom grant
   * (always requires approval). Built-in global roles follow env policy.
   */
  customWriteAlwaysNeedsApproval: boolean;
  scope: 'global' | 'grants' | 'mixed';
  /** Project / environment visibility (drives list APIs + UI picker). */
  workspace: WorkspaceAccess;
  canApprove: boolean;
  canBypassApproval: boolean;
  canManageUsers: boolean;
  /** Catalog snapshot for Admin UI builders. */
  domainCatalog: typeof ACCESS_DOMAIN_CATALOG;
}

function emptyDomains(): DomainPermissionMap {
  const out: DomainPermissionMap = {};
  for (const d of ACCESS_DOMAIN_CATALOG) out[d.id] = 'none';
  return out;
}

function norm(value: string | undefined | null): string {
  return (value || '').trim().toLowerCase();
}

function globalWorkspace(): WorkspaceAccess {
  return { mode: 'global', projects: ['*'], environments: { '*': ['*'] } };
}

function emptyWorkspace(): WorkspaceAccess {
  return { mode: 'grants', projects: [], environments: {} };
}

function mergeEnvLists(a: string[] | undefined, b: string[]): string[] {
  if (a?.includes('*') || b.includes('*')) return ['*'];
  return [...new Set([...(a || []), ...b].map(norm).filter(Boolean))];
}

/** Build project×env visibility from custom-group grants (dynamic — no hardcoding). */
export function workspaceFromGrants(grants: GroupAccessGrant[]): WorkspaceAccess {
  if (!grants.length) return emptyWorkspace();

  let allProjects = false;
  const projects = new Set<string>();
  const environments: Record<string, string[]> = {};

  for (const grant of grants) {
    const projKeys = grant.projects.includes('*')
      ? ['*']
      : grant.projects.map(norm).filter(Boolean);
    const envKeys = grant.environments.includes('*')
      ? ['*']
      : grant.environments.map(norm).filter(Boolean);

    if (projKeys.includes('*')) {
      allProjects = true;
      environments['*'] = mergeEnvLists(environments['*'], envKeys);
      continue;
    }

    for (const p of projKeys) {
      projects.add(p);
      environments[p] = mergeEnvLists(environments[p], envKeys);
    }
  }

  return {
    mode: 'grants',
    projects: allProjects ? ['*'] : [...projects],
    environments,
  };
}

export function canAccessProject(
  workspace: WorkspaceAccess,
  projectSlug: string | undefined | null
): boolean {
  if (workspace.mode === 'global' || workspace.projects.includes('*')) return true;
  const p = norm(projectSlug);
  if (!p) return false;
  return workspace.projects.includes(p);
}

export function canAccessEnvironment(
  workspace: WorkspaceAccess,
  projectSlug: string | undefined | null,
  environmentSlug: string | undefined | null
): boolean {
  if (workspace.mode === 'global') return true;
  if (!canAccessProject(workspace, projectSlug)) return false;

  const env = norm(environmentSlug);
  if (!env) return false;

  const p = norm(projectSlug);
  const fromStar = workspace.environments['*'] || [];
  const fromProject = p ? workspace.environments[p] || [] : [];
  const allowed = mergeEnvLists(fromStar, fromProject);
  if (!allowed.length) return false;
  return allowed.includes('*') || allowed.includes(env);
}

/** Unit / resource visibility for list APIs. */
export function canAccessWorkspacePair(
  workspace: WorkspaceAccess,
  projectSlug: string | undefined | null,
  environmentSlug: string | undefined | null
): boolean {
  return canAccessEnvironment(workspace, projectSlug, environmentSlug);
}

function demoAccess(ctx?: AccessContext): EffectiveAccess {
  const role = config.demoUser.role;
  const perms = permissionsForRole(role);
  const domains = { ...perms.domains };
  const workspace =
    perms.scope === 'global' ? globalWorkspace() : emptyWorkspace();
  return {
    role,
    domains,
    infrastructure: domainLevel(domains, 'infrastructure'),
    kubernetes: domainLevel(domains, 'kubernetes'),
    customWriteAlwaysNeedsApproval: false,
    scope: workspace.mode === 'global' ? 'global' : 'grants',
    workspace,
    canApprove: canApproveReleases(role),
    canBypassApproval: canBypassApproval(role),
    canManageUsers: canManageUsers(role),
    domainCatalog: ACCESS_DOMAIN_CATALOG,
  };
}

function hasWrite(domains: DomainPermissionMap): boolean {
  return Object.values(domains).some((level) => level === 'write');
}

function hasAnyDomainAccess(domains: DomainPermissionMap): boolean {
  return Object.values(domains).some((level) => level === 'read' || level === 'write');
}

/**
 * Resolve effective access for a user in an optional project×environment context.
 * Built-in roles (admin/maintainer/developer/superadmin) are global.
 * Custom group grants are project × environment × domain.
 */
export async function resolveAccessForUser(
  user: {
    id?: string;
    email: string;
    role: UserRole;
  },
  ctx?: AccessContext
): Promise<EffectiveAccess> {
  await ensureDefaultGroups();
  const rolePerms = permissionsForRole(user.role);
  const roleIsGlobal = rolePerms.scope === 'global';
  const roleDomains = { ...rolePerms.domains };

  const groups = await listGroups();
  const memberGroups = groups.filter(
    (g) => !g.system && user.id && g.memberUserIds.includes(user.id)
  );

  const allGrants: GroupAccessGrant[] = [];
  for (const g of memberGroups) {
    if (g.permissions.scope === 'grants' && g.permissions.grants?.length) {
      allGrants.push(...g.permissions.grants);
    }
  }

  const workspace = roleIsGlobal ? globalWorkspace() : workspaceFromGrants(allGrants);

  let fromGrants = emptyDomains();
  let customWriteInContext = false;

  for (const g of memberGroups) {
    const p = g.permissions;
    if (p.scope !== 'grants' || !p.grants?.length) continue;

    for (const grant of p.grants) {
      const matched = grantDomainsForContext(grant, ctx?.project, ctx?.environment);
      if (!matched) {
        // Without a specific context, union grant domains only for nav overview —
        // and only when the grant itself has some non-none domain.
        if (!ctx?.project && !ctx?.environment) {
          fromGrants = mergeDomainMaps(fromGrants, grant.domains);
          if (p.alwaysRequireApprovalForWrite && hasWrite(grant.domains)) {
            customWriteInContext = true;
          }
        }
        continue;
      }
      fromGrants = mergeDomainMaps(fromGrants, matched);
      if (p.alwaysRequireApprovalForWrite && hasWrite(matched)) {
        customWriteInContext = true;
      }
    }
  }

  // Grant-scoped users with an explicit project/env that is NOT in workspace get none.
  if (
    !roleIsGlobal &&
    (ctx?.project || ctx?.environment) &&
    !canAccessWorkspacePair(workspace, ctx?.project, ctx?.environment)
  ) {
    fromGrants = emptyDomains();
    customWriteInContext = false;
  }

  const domains = roleIsGlobal
    ? mergeDomainMaps(roleDomains, fromGrants)
    : fromGrants;

  const roleAlreadyWrites = roleIsGlobal && hasWrite(roleDomains);
  const customWriteAlwaysNeedsApproval = !roleAlreadyWrites && customWriteInContext;

  const scope: EffectiveAccess['scope'] =
    memberGroups.some((g) => g.permissions.scope === 'grants') && roleIsGlobal
      ? 'mixed'
      : !roleIsGlobal
        ? 'grants'
        : 'global';

  return {
    role: user.role,
    domains,
    infrastructure: domainLevel(domains, 'infrastructure'),
    kubernetes: domainLevel(domains, 'kubernetes'),
    customWriteAlwaysNeedsApproval,
    scope,
    workspace,
    canApprove: canApproveReleases(user.role),
    canBypassApproval: canBypassApproval(user.role),
    canManageUsers: canManageUsers(user.role),
    domainCatalog: ACCESS_DOMAIN_CATALOG,
  };
}

export async function resolveAccessByEmail(
  email: string,
  ctx?: AccessContext
): Promise<EffectiveAccess | null> {
  if (config.auth.disabled) return demoAccess(ctx);
  const user = await findUserByEmail(email);
  if (!user || user.disabled) return null;
  return resolveAccessForUser(user, ctx);
}

export async function resolveAccessById(
  id: string,
  ctx?: AccessContext
): Promise<EffectiveAccess | null> {
  if (config.auth.disabled) return demoAccess(ctx);
  const user = await findUserById(id);
  if (!user || user.disabled) return null;
  return resolveAccessForUser(user, ctx);
}

/** Plan needs read; apply / destroy / custom need write. */
export function requiredLevelForReleaseMode(mode: string): AccessLevel {
  if (mode === 'plan') return 'read';
  if (mode === 'apply' || mode === 'destroy' || mode === 'custom') return 'write';
  return 'write';
}

export function assertDomainAccess(
  access: EffectiveAccess,
  domain: AccessDomain,
  need: AccessLevel,
  actionLabel: string,
  ctx?: AccessContext
): void {
  if (
    ctx &&
    (ctx.project || ctx.environment) &&
    !canAccessWorkspacePair(access.workspace, ctx.project, ctx.environment)
  ) {
    throw new AccessError(
      `No access to ${[
        ctx.project && `project “${ctx.project}”`,
        ctx.environment && `environment “${ctx.environment}”`,
      ]
        .filter(Boolean)
        .join(', ')} for ${actionLabel}`,
      { project: ctx.project, environment: ctx.environment, action: actionLabel }
    );
  }

  const level = domainLevel(access.domains, domain);
  if (!accessAtLeast(level, need)) {
    const where = [
      ctx?.project ? `project “${ctx.project}”` : null,
      ctx?.environment ? `environment “${ctx.environment}”` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const hint = where ? ` (${where})` : '';
    throw new AccessError(
      `Insufficient ${domain} permission for ${actionLabel}${hint} (have ${level}, need ${need})`,
      {
        domain,
        have: level,
        need,
        project: ctx?.project,
        environment: ctx?.environment,
        action: actionLabel,
      }
    );
  }
}

export function releaseDomainForMode(_mode: string, releaseType?: string): AccessDomain {
  if (releaseType === 'kubernetes') return 'kubernetes';
  return 'infrastructure';
}

/** Whether the user has any product-domain access at all (nav overview). */
export function hasProductAccess(access: EffectiveAccess): boolean {
  if (access.workspace.mode === 'global') return true;
  return hasAnyDomainAccess(access.domains);
}
