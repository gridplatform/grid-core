/**
 * Resolve the catalog resource type for a stored infrastructure unit.
 *
 * Multi-resource units (e.g. VM + security-group in one JSON) should label as the
 * primary workload, not the first supporting resource in the array.
 */

/** Supporting / attachment types — never win over a primary resource in the same file. */
const SUPPORTING_TYPES = new Set([
  'security-group',
  'security_group',
  'sg',
  'subnet',
  'route-table',
  'route_table',
  'internet-gateway',
  'nat-gateway',
  'elastic-ip',
  'eip',
  'network-acl',
  'nacl',
  'iam-role',
  'iam-policy',
  'instance-profile',
  'key-pair',
  'keypair',
]);

/** Higher = more likely the unit's main purpose. */
const PRIMARY_RANK: Record<string, number> = {
  vm: 100,
  ec2: 100,
  'ec2-instance': 100,
  instance: 95,
  eks: 90,
  gke: 90,
  aks: 90,
  'kubernetes-cluster': 90,
  rds: 85,
  's3-bucket': 80,
  bucket: 80,
  vpc: 70,
  alb: 65,
  nlb: 65,
};

function normalizeType(raw: string): string {
  return raw.trim().toLowerCase();
}

function rankType(type: string): number {
  if (SUPPORTING_TYPES.has(type)) return -10;
  if (PRIMARY_RANK[type] != null) return PRIMARY_RANK[type];
  // Heuristic primaries
  if (/^(vm|ec2|instance|eks|gke|aks|rds|aurora)/.test(type)) return 90;
  if (/security-group|subnet|iam-|route-/.test(type)) return -5;
  return 10;
}

/** Pick the primary resource type from a multi-resource intent. */
export function pickPrimaryResourceType(
  resources: Array<{ type?: unknown }>
): string | undefined {
  let best: { type: string; rank: number; index: number } | undefined;
  for (let i = 0; i < resources.length; i++) {
    const raw = resources[i]?.type;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const type = normalizeType(raw);
    const rank = rankType(type);
    if (!best || rank > best.rank || (rank === best.rank && i < best.index)) {
      best = { type, rank, index: i };
    }
  }
  return best?.type;
}

function typeFromGitPath(gitPath: string): string | undefined {
  const parts = gitPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (parent && parent !== 'projects') return parent.toLowerCase();
  }
  return undefined;
}

/**
 * Resolve the catalog resource type for a stored infrastructure unit.
 * Prefer primary resource from intent JSON; git path folder; then name.
 */
export function resolveResourceType(input: {
  configJson?: Record<string, unknown> | null;
  gitPath?: string | null;
  name?: string;
}): string {
  const cfg = input.configJson;
  const fromGit = input.gitPath ? typeFromGitPath(input.gitPath) : undefined;

  if (cfg && typeof cfg === 'object') {
    const resources = cfg.resources;
    if (Array.isArray(resources) && resources.length > 0) {
      const primary = pickPrimaryResourceType(
        resources as Array<{ type?: unknown }>
      );
      if (primary) {
        // Path folder wins when it is more specific/primary than a supporting pick
        // e.g. …/ec2/foo.json with [security-group, vm] → ec2 or vm (both compute).
        if (fromGit && rankType(fromGit) >= rankType(primary)) {
          return fromGit;
        }
        return primary;
      }
    }
    const meta = cfg.metadata as { modulePath?: string } | undefined;
    if (typeof meta?.modulePath === 'string' && meta.modulePath.trim()) {
      const seg = meta.modulePath.split('/').filter(Boolean).pop();
      if (seg) return seg.toLowerCase();
    }
  }

  if (fromGit) return fromGit;

  if (input.name?.trim()) return input.name.trim().toLowerCase();
  return 'unknown';
}
