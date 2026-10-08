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
  type UserRole,
} from '../auth/rbac';
import { ensureDefaultGroups, listGroups } from '../store/groupStore';
import { findUserByEmail, findUserById } from '../store/userStore';
import { config } from '../config';

export interface AccessContext {
  project?: string;
  environment?: string;
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

function demoAccess(ctx?: AccessContext): EffectiveAccess {
  const role = config.demoUser.role;
  const perms = permissionsForRole(role);
  const domains = { ...perms.domains };
  return {
    role,
    domains,
    infrastructure: domainLevel(domains, 'infrastructure'),
    kubernetes: domainLevel(domains, 'kubernetes'),
    customWriteAlwaysNeedsApproval: false,
    scope: 'global',
    canApprove: canApproveReleases(role),
    canBypassApproval: canBypassApproval(role),
    canManageUsers: canManageUsers(role),
    domainCatalog: ACCESS_DOMAIN_CATALOG,
  };
}

function hasWrite(domains: DomainPermissionMap): boolean {
  return Object.values(domains).some((level) => level === 'write');
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

  let fromGrants = emptyDomains();
  let customWriteInContext = false;

  for (const g of memberGroups) {
    const p = g.permissions;
    if (p.scope !== 'grants' || !p.grants?.length) continue;

    for (const grant of p.grants) {
      const matched = grantDomainsForContext(grant, ctx?.project, ctx?.environment);
      if (!matched) {
        // Without a specific context, union all grant domains for /auth/me overview.
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

  const domains = roleIsGlobal
    ? mergeDomainMaps(roleDomains, fromGrants)
    : ctx?.project || ctx?.environment
      ? fromGrants
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
  const level = domainLevel(access.domains, domain);
  if (!accessAtLeast(level, need)) {
    const where = [
      ctx?.project ? `project “${ctx.project}”` : null,
      ctx?.environment ? `environment “${ctx.environment}”` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const hint = where ? ` (${where})` : '';
    throw new Error(
      `Insufficient ${domain} permission for ${actionLabel}${hint} (have ${level}, need ${need})`
    );
  }
}

export function releaseDomainForMode(_mode: string, releaseType?: string): AccessDomain {
  if (releaseType === 'kubernetes') return 'kubernetes';
  return 'infrastructure';
}
