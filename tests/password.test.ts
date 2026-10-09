import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';

describe('password', () => {
  it('hashes and verifies matching passwords', async () => {
    const stored = await hashPassword('s3cret!');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('s3cret!', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$foo$bar$baz')).toBe(false);
  });
});
