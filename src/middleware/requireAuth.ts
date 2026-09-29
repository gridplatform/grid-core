import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import {
  demoUserAsPublic,
  extractTokenFromRequest,
  resolveBearerToken,
} from '../auth/authService';
import type { User } from '../types/api';

const PUBLIC_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/health$/ },
  { method: 'POST', path: /^\/auth\/login$/ },
  { method: 'POST', path: /^\/auth\/register$/ },
];

export function isPublicV1Route(req: Request): boolean {
  return PUBLIC_ROUTES.some(
    (r) => r.method === req.method && r.path.test(req.path)
  );
}

export async function attachAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (config.auth.disabled) {
    req.gridUser = demoUserAsPublic();
    next();
    return;
  }

  if (isPublicV1Route(req)) {
    next();
    return;
  }

  const bearer = extractTokenFromRequest(req.header('authorization'));
  const apiToken = req.header('x-grid-token')?.trim();
  const token = bearer || apiToken;

  const user = await resolveBearerToken(token);
  if (!user) {
    res.status(401).json({
      code: 'unauthorized',
      message: 'Authentication required. Log in or send Authorization: Bearer <token>.',
    });
    return;
  }

  req.gridUser = user;
  next();
}

export function requireRole(...roles: User['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.gridUser;
    if (!user) {
      res.status(401).json({ code: 'unauthorized', message: 'Authentication required' });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ code: 'forbidden', message: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export function getActorEmail(req: Request): string {
  return req.gridUser?.email ?? config.demoUser.email;
}

export function getActorId(req: Request): string {
  return req.gridUser?.id ?? config.demoUser.id;
}
