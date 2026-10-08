import type { User } from '../types/api';

export type UserRole = User['role'];

/**
 * Roles admin / superadmin may assign (never superadmin).
 * `member` = created with no access; elevate via predefined role or custom group.
 */
export const ASSIGNABLE_ROLES: UserRole[] = ['member', 'developer', 'maintainer', 'admin'];

/** Predefined roles that grant global access (all projects / envs / domains). */
export const PREDEFINED_ACCESS_ROLES: UserRole[] = ['developer', 'maintainer', 'admin'];

/**
 * none — no access
 * read — plan / view (does not change cloud); for UI surfaces = view-only
 * write — apply / destroy / manage (implies read); unused on pure view domains
 */
export type AccessLevel = 'none' | 'read' | 'write';

/**
 * Extensible catalog of permission domains.
 * Add new UI surfaces here (APM, logs, topology, secrets, …) — grants stay the same shape.
 */
export const ACCESS_DOMAIN_CATALOG = [
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Terraform / OpenTofu plan and apply',
    levels: ['none', 'read', 'write'] as const,
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    description: 'Workload releases and cluster views',
    levels: ['none', 'read', 'write'] as const,
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    description: 'Health, metrics, and alerts',
    levels: ['none', 'read', 'write'] as const,
  },
  {
    id: 'apm',
    label: 'APM',
    description: 'Application performance monitoring',
    levels: ['none', 'read', 'write'] as const,
  },
  {
    id: 'logs',
    label: 'Logs',
    description: 'Log search and retention views',
    levels: ['none', 'read', 'write'] as const,
  },
  {
    id: 'topology',
    label: 'Topology',
    description: 'Service / infra topology maps',
    levels: ['none', 'read', 'write'] as const,
  },
  {
    id: 'secrets',
    label: 'Secrets',
    description: 'Secret references and metadata (never raw values in UI)',
    levels: ['none', 'read', 'write'] as const,
  },
] as const;

export type KnownAccessDomain = (typeof ACCESS_DOMAIN_CATALOG)[number]['id'];

/** Known domains plus future string ids (scalable). */
export type AccessDomain = KnownAccessDomain | (string & {});

/** Domain → access level. Unknown keys are allowed for forward compatibility. */
export type DomainPermissionMap = Record<string, AccessLevel>;

/**
 * One grant row in a custom group:
 * which projects × which environments × which domain levels.
 */
export interface GroupAccessGrant {
  /** Project slugs. `['*']` = all projects. */
  projects: string[];
  /** Environment slugs. `['*']` = all environments. */
  environments: string[];
  /** Domain permissions within this project×env scope. */
  domains: DomainPermissionMap;
}

export type PermissionScope = 'global' | 'grants';

export interface GroupPermissionSpec {
  /**
   * Built-in role groups: false → follow per-environment approval policy.
   * Custom groups: true → write actions always require approval (superadmin still bypasses).
   */
  alwaysRequireApprovalForWrite: boolean;
  /**
   * global — all projects and environments (built-in RBAC roles).
   * grants — only the project×environment×domain rows in `grants` (custom groups).
   */
  scope: PermissionScope;
  /**
   * When scope === 'global': domain levels for every project and environment.
   * Always includes infrastructure + kubernetes; other catalog domains too.
   */
  domains: DomainPermissionMap;
  /** When scope === 'grants': explicit project × environment × domain matrix. */
  grants?: GroupAccessGrant[];
}

const ALL = ['*'];

function fullWriteDomains(): DomainPermissionMap {
  const domains: DomainPermissionMap = {};
  for (const d of ACCESS_DOMAIN_CATALOG) {
    domains[d.id] = 'write';
  }
  return domains;
}

function noAccessDomains(): DomainPermissionMap {
  const domains: DomainPermissionMap = {};
  for (const d of ACCESS_DOMAIN_CATALOG) {
    domains[d.id] = 'none';
  }
  return domains;
}

export const FULL_WRITE_DOMAINS = fullWriteDomains();
export const NO_ACCESS_DOMAINS = noAccessDomains();

/** Built-in groups seeded on first boot. */
export const DEFAULT_GROUPS = [
  {
    id: 'group-superadmins',
    slug: 'superadmins',
    name: 'Superadmins',
    description:
      'Bootstrap identity. Global access to all projects and environments. May release without approval.',
    system: true,
    permissions: {
      domains: fullWriteDomains(),
      alwaysRequireApprovalForWrite: false,
      scope: 'global' as const,
    },
  },
  {
    id: 'group-admins',
    slug: 'admins',
    name: 'Admins',
    description:
      'Global access to all projects and environments. User management. Releases still follow environment approval policy.',
    system: true,
    permissions: {
      domains: fullWriteDomains(),
      alwaysRequireApprovalForWrite: false,
      scope: 'global' as const,
    },
  },
  {
    id: 'group-maintainers',
    slug: 'maintainers',
    name: 'Maintainers',
    description:
      'Global access. Approves apply / destroy / custom releases for others. Own releases follow environment approval policy.',
    system: true,
    permissions: {
      domains: fullWriteDomains(),
      alwaysRequireApprovalForWrite: false,
      scope: 'global' as const,
    },
  },
  {
    id: 'group-developers',
    slug: 'developers',
    name: 'Developers',
    description:
      'Global access to all projects and environments. May plan and request apply; desired-state edits are via Git. Approvals from maintainers or admins.',
    system: true,
    permissions: {
      domains: fullWriteDomains(),
      alwaysRequireApprovalForWrite: false,
      scope: 'global' as const,
    },
  },
] as const;

export function isSuperAdmin(role: UserRole | undefined | null): boolean {
  return role === 'superadmin';
}

export function canManageUsers(role: UserRole | undefined | null): boolean {
  return role === 'admin' || role === 'superadmin';
}

export function canApproveReleases(role: UserRole | undefined | null): boolean {
  return role === 'maintainer' || role === 'admin' || role === 'superadmin';
}

export function canDestroyInfrastructure(role: UserRole | undefined | null): boolean {
  return role === 'admin' || role === 'superadmin';
}

export function canBypassApproval(role: UserRole | undefined | null): boolean {
  return role === 'superadmin';
}

export function roleDefaultGroupSlug(role: UserRole): string | null {
  switch (role) {
    case 'superadmin':
      return 'superadmins';
    case 'admin':
      return 'admins';
    case 'maintainer':
      return 'maintainers';
    case 'developer':
      return 'developers';
    case 'member':
      return null;
    default:
      return 'developers';
  }
}

/** Permissions implied by a built-in role. */
export function permissionsForRole(role: UserRole): GroupPermissionSpec {
  if (role === 'member') {
    return {
      domains: { ...NO_ACCESS_DOMAINS },
      alwaysRequireApprovalForWrite: true,
      scope: 'grants',
      grants: [],
    };
  }
  const slug = roleDefaultGroupSlug(role);
  const def = slug ? DEFAULT_GROUPS.find((g) => g.slug === slug) : undefined;
  if (def) {
    return {
      domains: { ...def.permissions.domains },
      alwaysRequireApprovalForWrite: def.permissions.alwaysRequireApprovalForWrite,
      scope: def.permissions.scope,
    };
  }
  return {
    domains: { ...NO_ACCESS_DOMAINS },
    alwaysRequireApprovalForWrite: true,
    scope: 'grants',
    grants: [],
  };
}

export function accessAtLeast(level: AccessLevel, need: AccessLevel): boolean {
  const rank = { none: 0, read: 1, write: 2 };
  return rank[level] >= rank[need];
}

export function mergeAccessLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  const rank = { none: 0, read: 1, write: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function mergeDomainMaps(
  a: DomainPermissionMap,
  b: DomainPermissionMap
): DomainPermissionMap {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: DomainPermissionMap = {};
  for (const key of keys) {
    out[key] = mergeAccessLevel(a[key] || 'none', b[key] || 'none');
  }
  return out;
}

export function normalizeAccessLevel(value: unknown): AccessLevel {
  if (value === 'read' || value === 'write' || value === 'none') return value;
  return 'none';
}

export function normalizeDomainMap(
  input?: Partial<DomainPermissionMap> | null
): DomainPermissionMap {
  const out: DomainPermissionMap = { ...NO_ACCESS_DOMAINS };
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    const id = key.trim().toLowerCase();
    if (!id) continue;
    out[id] = normalizeAccessLevel(value);
  }
  return out;
}

function normalizeSlugList(list: unknown, fallbackAll = false): string[] {
  if (!Array.isArray(list) || list.length === 0) {
    return fallbackAll ? [...ALL] : [];
  }
  const cleaned = list
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  if (cleaned.includes('*')) return [...ALL];
  return [...new Set(cleaned)];
}

export function normalizeGrant(raw: Partial<GroupAccessGrant> | GroupAccessGrant): GroupAccessGrant {
  return {
    projects: normalizeSlugList(raw.projects, true),
    environments: normalizeSlugList(raw.environments, true),
    domains: normalizeDomainMap(raw.domains),
  };
}

export function normalizeGrants(
  input?: Array<Partial<GroupAccessGrant> | GroupAccessGrant> | null
): GroupAccessGrant[] {
  if (!Array.isArray(input)) return [];
  return input.map(normalizeGrant);
}

export function scopeMatches(list: string[], target: string | undefined): boolean {
  if (list.includes('*')) return true;
  if (!target) return list.includes('*');
  const key = target.trim().toLowerCase();
  return list.some((s) => s === key);
}

/** Domain levels from a grant that applies to this project + environment. */
export function grantDomainsForContext(
  grant: GroupAccessGrant,
  project?: string,
  environment?: string
): DomainPermissionMap | null {
  if (!scopeMatches(grant.projects, project)) return null;
  if (!scopeMatches(grant.environments, environment)) return null;
  return { ...grant.domains };
}

/**
 * Migrate older permission shapes into the grants model.
 * - Top-level infrastructure/kubernetes
 * - scope: 'environments' + environments map
 */
export function migratePermissionSpec(raw: Record<string, unknown>): GroupPermissionSpec {
  const always =
    typeof raw.alwaysRequireApprovalForWrite === 'boolean'
      ? raw.alwaysRequireApprovalForWrite
      : true;

  if (raw.scope === 'global' && raw.domains && typeof raw.domains === 'object') {
    return {
      alwaysRequireApprovalForWrite: always,
      scope: 'global',
      domains: normalizeDomainMap(raw.domains as DomainPermissionMap),
    };
  }

  if (raw.scope === 'grants' || Array.isArray(raw.grants)) {
    return {
      alwaysRequireApprovalForWrite: always,
      scope: 'grants',
      domains: { ...NO_ACCESS_DOMAINS },
      grants: normalizeGrants(raw.grants as GroupAccessGrant[]),
    };
  }

  // Legacy: environments map → grants (all projects)
  if (raw.environments && typeof raw.environments === 'object') {
    const grants: GroupAccessGrant[] = [];
    for (const [env, perms] of Object.entries(
      raw.environments as Record<string, DomainPermissionMap>
    )) {
      grants.push({
        projects: [...ALL],
        environments: [env.toLowerCase()],
        domains: normalizeDomainMap(perms),
      });
    }
    return {
      alwaysRequireApprovalForWrite: always,
      scope: 'grants',
      domains: { ...NO_ACCESS_DOMAINS },
      grants,
    };
  }

  // Legacy top-level infra/k8s only → one grant (all projects, all envs) or development
  const legacyInfra = normalizeAccessLevel(raw.infrastructure);
  const legacyK8s = normalizeAccessLevel(raw.kubernetes);
  if (legacyInfra !== 'none' || legacyK8s !== 'none') {
    return {
      alwaysRequireApprovalForWrite: always,
      scope: 'grants',
      domains: { ...NO_ACCESS_DOMAINS },
      grants: [
        {
          projects: [...ALL],
          environments: [...ALL],
          domains: normalizeDomainMap({
            infrastructure: legacyInfra,
            kubernetes: legacyK8s,
          }),
        },
      ],
    };
  }

  return defaultCustomGroupPermissions();
}

/** Default custom group: development infra read, all other domains none. */
export function defaultCustomGroupPermissions(): GroupPermissionSpec {
  return {
    alwaysRequireApprovalForWrite: true,
    scope: 'grants',
    domains: { ...NO_ACCESS_DOMAINS },
    grants: [
      {
        projects: [...ALL],
        environments: ['development'],
        domains: normalizeDomainMap({
          infrastructure: 'read',
          kubernetes: 'none',
        }),
      },
    ],
  };
}

/** Convenience accessors kept for callers that still read infra/k8s directly. */
export function domainLevel(
  domains: DomainPermissionMap,
  domain: AccessDomain
): AccessLevel {
  return domains[domain] || 'none';
}
