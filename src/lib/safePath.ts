import path from 'path';

/**
 * Joins `relative` under `root` and throws if the result leaves `root`
 * (absolute input or `..` segments).
 */
export function resolveUnderRoot(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const trimmed = (relative || '').trim();
  if (!trimmed || trimmed === '.' || trimmed === './') {
    return resolvedRoot;
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error('Path must be relative to the configured root');
  }
  const resolved = path.resolve(resolvedRoot, trimmed);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel) {
    return resolvedRoot;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes configured root');
  }
  return resolved;
}
