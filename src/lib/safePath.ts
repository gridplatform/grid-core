import path from 'path';

/**
 * Resolve `relative` under `root` and reject escapes (../, absolute segments).
 * Use for gitPath, pathPrefix, and any operator-supplied path joined to a data root.
 */
export function resolveUnderRoot(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const trimmed = (relative || '').trim();
  if (!trimmed || trimmed === '.' || trimmed === './') {
    return resolvedRoot;
  }
  // Reject absolute inputs before join (path.resolve would ignore root on POSIX).
  if (path.isAbsolute(trimmed)) {
    throw new Error('Path must be relative to the configured root');
  }
  const resolved = path.resolve(resolvedRoot, trimmed);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel === '') {
    return resolvedRoot;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes configured root');
  }
  return resolved;
}

/** True when `candidate` is the same as or a descendant of `root`. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  try {
    resolveUnderRoot(root, path.relative(path.resolve(root), path.resolve(candidate)));
    return true;
  } catch {
    return false;
  }
}
