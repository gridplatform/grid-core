import type { Response } from 'express';

/**
 * Typed HTTP errors for route handlers.
 * Prefer throwing these (or AccessError) over stringly matching message text.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class AccessError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(403, 'forbidden', message, details);
    this.name = 'AccessError';
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

/** Map unknown errors to a stable API response body. */
export function errorResponse(err: unknown): {
  status: number;
  body: { code: string; message: string; details?: Record<string, unknown> };
} {
  if (isHttpError(err)) {
    return {
      status: err.status,
      body: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes('insufficient') ||
    lower.includes('no access') ||
    lower.includes('forbidden') ||
    lower.includes('not authorized')
  ) {
    return { status: 403, body: { code: 'forbidden', message } };
  }
  if (lower.includes('not found')) {
    return { status: 404, body: { code: 'not_found', message } };
  }
  if (lower.includes('already') || lower.includes('conflict') || lower.includes('in progress')) {
    return { status: 409, body: { code: 'conflict', message } };
  }

  return { status: 400, body: { code: 'request_error', message } };
}

export function sendError(res: Response, err: unknown): void {
  const { status, body } = errorResponse(err);
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json(body);
}
