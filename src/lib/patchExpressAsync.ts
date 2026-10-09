/**
 * Express 4 does not forward rejected promises from async route handlers to
 * the error middleware — they become unhandled rejections and can kill the
 * process. Patch Router HTTP verbs once so `.catch(next)` is automatic.
 *
 * Import this module before any `Router()` usage (see app.ts).
 */
import { Router } from 'express';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

let patched = false;

export function patchExpressAsync(): void {
  if (patched) return;
  patched = true;

  const proto = Router.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;

  for (const method of METHODS) {
    const original = proto[method];
    if (typeof original !== 'function') continue;

    proto[method] = function patchedMethod(this: unknown, ...args: unknown[]) {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        const handler = last as (
          req: unknown,
          res: unknown,
          next: (err?: unknown) => void
        ) => unknown;
        // Skip 4-arg error middleware.
        if (handler.length < 4) {
          args[args.length - 1] = (
            req: unknown,
            res: unknown,
            next: (err?: unknown) => void
          ) => {
            try {
              Promise.resolve(handler(req, res, next)).catch(next);
            } catch (err) {
              next(err);
            }
          };
        }
      }
      return original.apply(this, args);
    };
  }
}

patchExpressAsync();
