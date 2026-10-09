import { describe, expect, it } from 'vitest';
import { hashContent } from '../src/services/gitopsHash';

describe('hashContent', () => {
  it('returns a stable short hex digest', () => {
    const a = hashContent({ ok: true, n: 1 });
    const b = hashContent({ ok: true, n: 1 });
    const c = hashContent({ ok: true, n: 2 });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).not.toBe(c);
  });
});
