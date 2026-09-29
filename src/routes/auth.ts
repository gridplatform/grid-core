import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import {
  adminCreateUser,
  adminListUsers,
  adminPatchUser,
  AuthError,
  demoUserAsPublic,
  extractTokenFromRequest,
  login,
  logout,
  registerUser,
  resolveBearerToken,
} from '../auth/authService';
import { getActorEmail, requireRole } from '../middleware/requireAuth';

const router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
  role: z.enum(['developer', 'maintainer', 'admin']).default('developer'),
});

const PatchUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['developer', 'maintainer', 'admin']).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

function sendAuthError(res: import('express').Response, err: unknown) {
  if (err instanceof AuthError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  throw err;
}

router.get('/auth/me', (req, res) => {
  if (config.auth.disabled) {
    res.json(demoUserAsPublic());
    return;
  }
  if (!req.gridUser) {
    res.status(401).json({ code: 'unauthorized', message: 'Not authenticated' });
    return;
  }
  res.json(req.gridUser);
});

router.post('/auth/login', async (req, res) => {
  if (config.auth.disabled) {
    res.json({
      token: 'auth-disabled',
      user: demoUserAsPublic(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    return;
  }
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }
  try {
    const result = await login(parsed.data.email, parsed.data.password);
    res.json(result);
  } catch (err) {
    sendAuthError(res, err);
  }
});

router.post('/auth/register', async (req, res) => {
  if (config.auth.disabled) {
    res.status(403).json({ code: 'auth_disabled', message: 'Auth is disabled in this environment' });
    return;
  }
  try {
    const body = RegisterSchema.parse(req.body);
    const user = await registerUser(body);
    res.status(201).json({ user });
  } catch (err) {
    sendAuthError(res, err);
  }
});

router.post('/auth/refresh', async (req, res) => {
  if (config.auth.disabled) {
    res.json({ token: 'auth-disabled', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    return;
  }
  const bearer = extractTokenFromRequest(req.header('authorization'));
  const user = await resolveBearerToken(bearer);
  if (!user) {
    res.status(401).json({ code: 'unauthorized', message: 'Invalid or expired session' });
    return;
  }
  res.json({
    token: bearer,
    expiresAt: req.body?.expiresAt,
    user,
  });
});

router.post('/auth/logout', async (req, res) => {
  if (!config.auth.disabled) {
    const bearer = extractTokenFromRequest(req.header('authorization'));
    await logout(bearer);
  }
  res.status(204).end();
});

router.get('/auth/users', requireRole('admin'), async (_req, res) => {
  const users = await adminListUsers();
  res.json({ users });
});

router.post('/auth/users', requireRole('admin'), async (req, res) => {
  try {
    const body = CreateUserSchema.parse(req.body);
    const user = await adminCreateUser(body);
    console.log(`[auth] User ${user.email} created by ${getActorEmail(req)}`);
    res.status(201).json({ user });
  } catch (err) {
    sendAuthError(res, err);
  }
});

router.patch('/auth/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const body = PatchUserSchema.parse(req.body);
    const user = await adminPatchUser(req.params.id, body);
    if (!user) {
      res.status(404).json({ code: 'not_found', message: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (err) {
    sendAuthError(res, err);
  }
});

export default router;
