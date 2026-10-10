import { describe, expect, it } from 'vitest';
import { formatLogTimestamp } from '../src/lib/log';

describe('formatLogTimestamp', () => {
  it('formats local wall clock with milliseconds', () => {
    const d = new Date(2026, 9, 10, 11, 43, 5, 123); // month is 0-indexed
    expect(formatLogTimestamp(d)).toBe('2026-10-10 11:43:05.123');
  });
});
