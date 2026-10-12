/**
 * Unit identity for Grid inventory + monitoring (`grid_unit_id`).
 *
 * Terraform state / archive stay **path-based** (maintainability + exit model).
 * This id is only a join key — not the TF state address.
 *
 * Default (no commit, no DB): UUID v5(`gitPath`) — same path always yields the
 * same id after Grid store wipe/reinstall. That is enough for monitoring.
 *
 * Optional: explicit `metadata.id` / top-level `id` if an author sets one
 * (rename-safe for Grid/monitoring). Grid does **not** auto-write that field.
 *
 * A separate ID database is unnecessary for path-stable units and would tie
 * durability to Grid’s data plane (worse exit story than path math).
 */

import { v5 as uuidv5 } from 'uuid';

/** Same namespace as historical GitOps path→id derivation — do not change. */
export const GRID_UNIT_ID_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUnitId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/** Read an explicit id from config if the author (or a prior stamp) set one. */
export function readExplicitUnitId(cfg: Record<string, unknown>): string | undefined {
  if (isUnitId(cfg.id)) return cfg.id.trim();
  const meta = cfg.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const id = (meta as { id?: unknown }).id;
    if (isUnitId(id)) return id.trim();
  }
  return undefined;
}

/** Path-derived id — used only when JSON has no explicit id yet. */
export function unitIdFromGitPath(gitPath: string): string {
  const normalized = gitPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return uuidv5(normalized, GRID_UNIT_ID_NS);
}

/**
 * Resolve the unit id for a desired-state file.
 * Explicit id wins (rename-safe for Grid/monitoring). Path v5 is bootstrap only.
 */
export function resolveUnitId(gitPath: string, cfg: Record<string, unknown>): string {
  return readExplicitUnitId(cfg) ?? unitIdFromGitPath(gitPath);
}

export interface EnsuredUnitId {
  id: string;
  cfg: Record<string, unknown>;
  /** True when we wrote `metadata.id` because it was missing. */
  stamped: boolean;
}

/**
 * Resolve id; optionally return an in-memory cfg with `metadata.id` filled.
 * Callers that must not dirty Git should use `id` only and ignore `cfg`/`stamped`.
 */
export function ensureUnitIdInConfig(
  gitPath: string,
  cfg: Record<string, unknown>
): EnsuredUnitId {
  const existing = readExplicitUnitId(cfg);
  if (existing) {
    return { id: existing, cfg, stamped: false };
  }

  const id = unitIdFromGitPath(gitPath);
  return { id, cfg, stamped: false };
}
