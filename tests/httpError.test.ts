import { describe, expect, it } from 'vitest';
import {
  AccessError,
  HttpError,
  errorResponse,
  isHttpError,
} from '../src/lib/httpError';

describe('httpError', () => {
  it('recognizes typed errors', () => {
    const err = new AccessError('denied');
    expect(isHttpError(err)).toBe(true);
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
  });

  it('maps AccessError via errorResponse', () => {
    const mapped = errorResponse(new AccessError('No access to project'));
    expect(mapped.status).toBe(403);
    expect(mapped.body.code).toBe('forbidden');
  });

  it('maps message heuristics for legacy throws', () => {
    expect(errorResponse(new Error('Insufficient infrastructure permission')).status).toBe(
      403
    );
    expect(errorResponse(new Error('Release not found')).status).toBe(404);
    expect(errorResponse(new Error('sync already in progress')).status).toBe(409);
    expect(errorResponse(new Error('validation failed')).status).toBe(400);
  });

  it('preserves HttpError details', () => {
    const err = new HttpError(409, 'conflict', 'busy', { id: '1' });
    const mapped = errorResponse(err);
    expect(mapped.body.details).toEqual({ id: '1' });
  });
});
