/**
 * Resolve the catalog resource type for a stored infrastructure unit.
 * Prefer resources[0].type from intent JSON; fall back to path / modulePath.
 */
export function resolveResourceType(input: {
  configJson?: Record<string, unknown> | null;
  gitPath?: string | null;
  name?: string;
}): string {
  const cfg = input.configJson;
  if (cfg && typeof cfg === 'object') {
    const resources = cfg.resources;
    if (Array.isArray(resources) && resources.length > 0) {
      const first = resources[0] as { type?: unknown };
      if (typeof first?.type === 'string' && first.type.trim()) {
        return first.type.trim().toLowerCase();
      }
    }
    const meta = cfg.metadata as { modulePath?: string } | undefined;
    if (typeof meta?.modulePath === 'string' && meta.modulePath.trim()) {
      const seg = meta.modulePath.split('/').filter(Boolean).pop();
      if (seg) return seg.toLowerCase();
    }
  }

  const gitPath = input.gitPath?.replace(/\\/g, '/');
  if (gitPath) {
    // projects/<slug>/<cloud>/<env>/<type>/file.json → type is parent of the file
    const parts = gitPath.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const parent = parts[parts.length - 2];
      if (parent && parent !== 'projects') return parent.toLowerCase();
    }
  }

  if (input.name?.trim()) return input.name.trim().toLowerCase();
  return 'unknown';
}
