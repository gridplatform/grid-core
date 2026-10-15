/**
 * Field extractors for desired-state JSON (GitOps + config-root sync).
 */

/** Unit display name from metadata.name, top-level name, or folder fallback. */
export function nameFromConfig(
  cfg: Record<string, unknown>,
  fallback: string
): string {
  const meta = cfg.metadata as { name?: string } | undefined;
  return meta?.name || (typeof cfg.name === 'string' ? cfg.name : fallback);
}

/** Environment from metadata or top-level field when present. */
export function environmentFromMetadata(
  cfg: Record<string, unknown>
): string | undefined {
  const meta = cfg.metadata as { environment?: string } | undefined;
  if (meta?.environment) return meta.environment;
  if (typeof cfg.environment === 'string') return cfg.environment;
  return undefined;
}
