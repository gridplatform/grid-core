import { createHash } from 'crypto';

export function hashContent(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}
