import path from 'path';
import fs from 'fs-extra';

/**
 * Shared durable JSON I/O for GRID_DATA_DIR files.
 *
 * - Writes are always atomic (tmp + rename) so readers never see a truncated file.
 * - Reads tolerate empty / corrupt JSON (optional quarantine + fallback).
 */

export async function writeJsonAtomic(
  file: string,
  data: unknown,
  options?: { spaces?: number | false }
): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  const spaces = options?.spaces === false ? undefined : options?.spaces ?? 2;
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  if (spaces === undefined) {
    await fs.writeJSON(tmp, data);
  } else {
    await fs.writeJSON(tmp, data, { spaces });
  }
  await fs.move(tmp, file, { overwrite: true });
}

export type ReadJsonSafeOptions = {
  /** When true, move unreadable files aside as `*.corrupt.<ts>`. Default true. */
  quarantine?: boolean;
  /** Log label, e.g. "gitops-settings". */
  label?: string;
};

/**
 * Read and parse JSON. Returns null if missing, empty, or corrupt.
 * Never throws for parse/IO of a bad file body.
 */
export async function readJsonSafe<T = unknown>(
  file: string,
  options: ReadJsonSafeOptions = {}
): Promise<T | null> {
  const quarantine = options.quarantine !== false;
  const label = options.label || path.basename(file);

  try {
    if (!(await fs.pathExists(file))) return null;
  } catch {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    console.warn(
      `[json] failed to read ${label}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  if (!raw.trim()) {
    console.warn(`[json] empty file ${label} — treating as missing`);
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(
      `[json] corrupt ${label}:`,
      err instanceof Error ? err.message : err
    );
    if (quarantine) {
      const bak = `${file}.corrupt.${Date.now()}`;
      try {
        await fs.move(file, bak, { overwrite: true });
        console.warn(`[json] quarantined ${label} → ${path.basename(bak)}`);
      } catch {
        try {
          await fs.remove(file);
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }
}

/**
 * Load JSON or write `fallback` atomically and return it.
 */
export async function readJsonOrInit<T>(
  file: string,
  fallback: T | (() => T),
  options?: ReadJsonSafeOptions & { spaces?: number | false }
): Promise<T> {
  const existing = await readJsonSafe<T>(file, options);
  if (existing !== null && existing !== undefined) {
    return existing;
  }
  const value =
    typeof fallback === 'function' ? (fallback as () => T)() : fallback;
  await writeJsonAtomic(file, value, { spaces: options?.spaces });
  return value;
}
