/**
 * Unit identity — catalog-agnostic.
 *
 * Contract:
 * - Unit kind = what the unit is (`metadata.kind` / deploy `resourceType` / path folder).
 * - In `resources[]`, primary = the entry matching that kind, or `role: "primary"`.
 * - Everything else in that unit is secondary.
 *
 * Family/category (compute, network, containers, …) lives in the catalog.
 * This module does not rank products and does not maintain a support-type list.
 */

export type ResourceRole = 'primary' | 'support';

type ResourceLike = {
  type?: unknown;
  role?: unknown;
};

function normalizeType(raw: string): string {
  return raw.trim().toLowerCase();
}

function readRole(resource: ResourceLike): ResourceRole | undefined {
  const role = resource.role;
  if (role === 'primary' || role === 'support') return role;
  return undefined;
}

/** Exact or hyphen specialization (`foo` ↔ `foo-bar`). */
export function typesMatchKind(resourceType: string, kind: string): boolean {
  const a = normalizeType(resourceType);
  const b = normalizeType(kind);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(`${b}-`) || b.startsWith(`${a}-`)) return true;
  return false;
}

function resourceTypeOf(resource: ResourceLike): string | undefined {
  const raw = resource.type;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return normalizeType(raw);
}

/**
 * Pick the primary resource type inside a unit.
 * Prefers explicit `role`, then match to `unitKind`, then first non-support role.
 */
export function pickPrimaryResourceType(
  resources: ResourceLike[],
  unitKind?: string
): string | undefined {
  if (!resources.length) return undefined;
  const kind = unitKind?.trim() ? normalizeType(unitKind) : undefined;

  for (const r of resources) {
    const t = resourceTypeOf(r);
    if (t && readRole(r) === 'primary') return t;
  }

  if (kind) {
    for (const r of resources) {
      const t = resourceTypeOf(r);
      if (t && readRole(r) !== 'support' && typesMatchKind(t, kind)) return t;
    }
  }

  for (const r of resources) {
    const t = resourceTypeOf(r);
    if (t && readRole(r) !== 'support') return t;
  }

  for (const r of resources) {
    const t = resourceTypeOf(r);
    if (t) return t;
  }
  return undefined;
}

function rankForOrder(resource: ResourceLike, unitKind?: string): number {
  const role = readRole(resource);
  if (role === 'primary') return 1000;
  if (role === 'support') return -100;

  const t = resourceTypeOf(resource);
  if (!t) return -1000;
  const kind = unitKind?.trim() ? normalizeType(unitKind) : undefined;
  if (kind && typesMatchKind(t, kind)) return 900;
  return 0;
}

/** Stable order: primary first, secondaries after. */
export function orderResourcesPrimaryFirst<T extends ResourceLike>(
  resources: T[],
  unitKind?: string
): T[] {
  if (resources.length <= 1) return resources;
  return [...resources].sort((a, b) => {
    const ra = rankForOrder(a, unitKind);
    const rb = rankForOrder(b, unitKind);
    if (rb !== ra) return rb - ra;
    return 0;
  });
}

function typeFromGitPath(gitPath: string): string | undefined {
  const parts = gitPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (parent && parent !== 'projects') return parent.toLowerCase();
  }
  return undefined;
}

function kindFromConfig(cfg: Record<string, unknown> | null | undefined): string | undefined {
  if (!cfg || typeof cfg !== 'object') return undefined;
  const meta = cfg.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === 'object') {
    for (const key of ['kind', 'resourceType', 'unitKind'] as const) {
      const v = meta[key];
      if (typeof v === 'string' && v.trim()) return normalizeType(v);
    }
  }
  return undefined;
}

/**
 * Resolve display/catalog type for a stored unit.
 * Stamped kind wins; otherwise primary resource; then path / name.
 */
export function resolveResourceType(input: {
  configJson?: Record<string, unknown> | null;
  gitPath?: string | null;
  name?: string;
}): string {
  const cfg = input.configJson;
  const stamped = kindFromConfig(cfg);
  const fromGit = input.gitPath ? typeFromGitPath(input.gitPath) : undefined;
  const unitKind = stamped || fromGit;

  if (cfg && typeof cfg === 'object') {
    const resources = cfg.resources;
    if (Array.isArray(resources) && resources.length > 0) {
      const primary = pickPrimaryResourceType(
        resources as ResourceLike[],
        unitKind
      );
      if (stamped) return stamped;
      if (primary) return primary;
    }
    const meta = cfg.metadata as { modulePath?: string } | undefined;
    if (typeof meta?.modulePath === 'string' && meta.modulePath.trim()) {
      const seg = meta.modulePath.split('/').filter(Boolean).pop();
      if (seg) return seg.toLowerCase();
    }
  }

  if (stamped) return stamped;
  if (fromGit) return fromGit;
  if (input.name?.trim()) return input.name.trim().toLowerCase();
  return 'unknown';
}
