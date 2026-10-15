import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveUnderRoot } from '../src/lib/safePath';

describe('resolveUnderRoot', () => {
  const root = path.resolve('/tmp/grid-config-root');

  it('resolves a normal relative path', () => {
    const out = resolveUnderRoot(root, 'projects/demo-app/aws/dev/vpc.json');
    expect(out).toBe(path.join(root, 'projects/demo-app/aws/dev/vpc.json'));
  });

  it('rejects .. traversal', () => {
    expect(() => resolveUnderRoot(root, '../etc/passwd')).toThrow(/escapes|relative/i);
    expect(() => resolveUnderRoot(root, 'projects/../../etc/passwd')).toThrow(/escapes/i);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveUnderRoot(root, '/etc/passwd')).toThrow(/relative/i);
  });

  it('allows empty / . as the root itself', () => {
    expect(resolveUnderRoot(root, '')).toBe(path.resolve(root));
    expect(resolveUnderRoot(root, '.')).toBe(path.resolve(root));
  });
});
