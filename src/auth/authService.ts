import crypto from 'crypto';
import { config } from '../config';
import type { User } from '../types/api';
import { hashPassword, verifyPassword } from './password';
import { toPublicUser } from './types';
import {
  createSession,
  deleteSession,
  findSession,
  findUserByEmail,
  findUserById,
  insertUser,
  listUsers,
  normalizeEmail,
  purgeExpiredSessions,
  touchSession,
  updateUser,
  userCount,
} from '../store/userStore';

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 401
  ) {
    super(message);
  }
}

function sessionExpiresAt(): string {
  const ms = config.auth.sessionTtlHours * 3600 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

export function demoUserAsPublic(): User {
  return {
    id: config.demoUser.id,
    email: config.demoUser.email,
    name: config.demoUser.name,
    role: config.demoUser.role,
    createdAt: config.demoUser.createdAt,
  };
}

/** First-run bootstrap admin (Jenkins-style local user database). */
export async function ensureBootstrapAdmin(): Promise<void> {
  await purgeExpiredSessions();
  const count = await userCount();
  if (count > 0) return;

  const email = normalizeEmail(
    config.auth.bootstrap.email || 'admin@grid.local'
  );
  const password =
    config.auth.bootstrap.password ||
    crypto.randomBytes(12).toString('base64url');
  const name = config.auth.bootstrap.name || 'Grid Admin';

  await insertUser({
    email,
    name,
    role: 'admin',
    passwordHash: await hashPassword(password),
    disabled: false,
  });

  if (config.auth.bootstrap.password) {
    console.log(`[auth] Bootstrap admin created: ${email}`);
  } else {
    console.warn(
      `[auth] No users found — created bootstrap admin ${email} with one-time password: ${password}`
    );
    console.warn('[auth] Set GRID_AUTH_ADMIN_EMAIL / GRID_AUTH_ADMIN_PASSWORD for a fixed admin.');
  }
}

export async function login(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user || user.disabled) {
    throw new AuthError('invalid_credentials', 'Invalid email or password');
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new AuthError('invalid_credentials', 'Invalid email or password');
  }
  const session = await createSession(user.id, sessionExpiresAt());
  return {
    token: session.token,
    user: toPublicUser(user),
    expiresAt: session.expiresAt,
  };
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await deleteSession(token);
}

export async function resolveBearerToken(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const session = await findSession(token);
  if (!session) return null;
  const user = await findUserById(session.userId);
  if (!user || user.disabled) {
    await deleteSession(token);
    return null;
  }
  void touchSession(token);
  return toPublicUser(user);
}

export async function registerUser(input: {
  email: string;
  password: string;
  name: string;
}): Promise<User> {
  if (!config.auth.allowRegister) {
    throw new AuthError('registration_disabled', 'Registration is disabled', 403);
  }
  if (input.password.length < 8) {
    throw new AuthError('weak_password', 'Password must be at least 8 characters', 400);
  }
  try {
    const user = await insertUser({
      email: input.email,
      name: input.name.trim() || input.email.split('@')[0],
      role: 'developer',
      passwordHash: await hashPassword(input.password),
      disabled: false,
    });
    return toPublicUser(user);
  } catch (err) {
    if (err instanceof Error && err.message === 'email_taken') {
      throw new AuthError('email_taken', 'Email already registered', 409);
    }
    throw err;
  }
}

export async function adminCreateUser(input: {
  email: string;
  password: string;
  name: string;
  role: User['role'];
}): Promise<User> {
  if (input.password.length < 8) {
    throw new AuthError('weak_password', 'Password must be at least 8 characters', 400);
  }
  try {
    const user = await insertUser({
      email: input.email,
      name: input.name.trim(),
      role: input.role,
      passwordHash: await hashPassword(input.password),
      disabled: false,
    });
    return toPublicUser(user);
  } catch (err) {
    if (err instanceof Error && err.message === 'email_taken') {
      throw new AuthError('email_taken', 'Email already in use', 409);
    }
    throw err;
  }
}

export async function adminListUsers(): Promise<User[]> {
  const users = await listUsers();
  return users.map(toPublicUser);
}

export async function adminPatchUser(
  id: string,
  patch: { name?: string; role?: User['role']; disabled?: boolean; password?: string }
): Promise<User | undefined> {
  const updates: Parameters<typeof updateUser>[1] = {};
  if (patch.name !== undefined) updates.name = patch.name.trim();
  if (patch.role !== undefined) updates.role = patch.role;
  if (patch.disabled !== undefined) updates.disabled = patch.disabled;
  if (patch.password !== undefined) {
    if (patch.password.length < 8) {
      throw new AuthError('weak_password', 'Password must be at least 8 characters', 400);
    }
    updates.passwordHash = await hashPassword(patch.password);
  }
  const updated = await updateUser(id, updates);
  return updated ? toPublicUser(updated) : undefined;
}

export function extractTokenFromRequest(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return undefined;
}
