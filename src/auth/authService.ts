import crypto from 'crypto';
import { config } from '../config';
import type { User } from '../types/api';
import { hashPassword, verifyPassword } from './password';
import { toPublicUser } from './types';
import { ASSIGNABLE_ROLES, canManageUsers } from './rbac';
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
import { ensureDefaultGroups } from '../store/groupStore';

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

/**
 * First-run bootstrap superadmin (set via GRID_AUTH_ADMIN_* at deploy).
 * Also upgrades a legacy bootstrap admin → superadmin when email matches.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  await purgeExpiredSessions();
  const bootstrapEmail = normalizeEmail(
    config.auth.bootstrap.email || 'admin@grid.local'
  );

  const count = await userCount();
  if (count === 0) {
    const password =
      config.auth.bootstrap.password ||
      crypto.randomBytes(12).toString('base64url');
    const name = config.auth.bootstrap.name || 'Grid Superadmin';

    await insertUser({
      email: bootstrapEmail,
      name,
      role: 'superadmin',
      passwordHash: await hashPassword(password),
      disabled: false,
    });

    if (config.auth.bootstrap.password) {
      console.log(`[auth] Bootstrap superadmin created: ${bootstrapEmail}`);
    } else {
      console.warn(
        `[auth] No users found — created bootstrap superadmin ${bootstrapEmail} with one-time password: ${password}`
      );
      console.warn(
        '[auth] Set GRID_AUTH_ADMIN_EMAIL / GRID_AUTH_ADMIN_PASSWORD for a fixed superadmin.'
      );
    }
  } else {
    const existing = await findUserByEmail(bootstrapEmail);
    if (existing && existing.role === 'admin') {
      await updateUser(existing.id, { role: 'superadmin' });
      console.log(`[auth] Promoted bootstrap user ${bootstrapEmail} to superadmin`);
    }
  }

  await ensureDefaultGroups();
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
    // New accounts start with no domain access until admin/superadmin assigns
    // a predefined role (developer / maintainer / admin) or a custom group.
    const user = await insertUser({
      email: input.email,
      name: input.name.trim() || input.email.split('@')[0],
      role: 'member',
      passwordHash: await hashPassword(input.password),
      disabled: false,
    });
    await ensureDefaultGroups();
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
  if (!ASSIGNABLE_ROLES.includes(input.role)) {
    throw new AuthError(
      'invalid_role',
      'Assignable roles are member (no access), developer, maintainer, and admin. Superadmin is only the bootstrap account.',
      400
    );
  }
  try {
    const user = await insertUser({
      email: input.email,
      name: input.name.trim(),
      role: input.role,
      passwordHash: await hashPassword(input.password),
      disabled: false,
    });
    await ensureDefaultGroups();
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
  patch: { name?: string; role?: User['role']; disabled?: boolean; password?: string },
  actor?: User | null
): Promise<User | undefined> {
  const target = await findUserById(id);
  if (!target) return undefined;

  if (target.role === 'superadmin') {
    if (patch.role && patch.role !== 'superadmin') {
      throw new AuthError('forbidden', 'Cannot change the superadmin role', 403);
    }
    if (patch.disabled === true) {
      throw new AuthError('forbidden', 'Cannot disable the superadmin account', 403);
    }
  }

  if (patch.role !== undefined) {
    if (patch.role === 'superadmin') {
      throw new AuthError(
        'invalid_role',
        'Cannot assign superadmin. That role is only the bootstrap account.',
        400
      );
    }
    if (!ASSIGNABLE_ROLES.includes(patch.role)) {
      throw new AuthError('invalid_role', 'Invalid role', 400);
    }
  }

  if (actor && !canManageUsers(actor.role)) {
    throw new AuthError('forbidden', 'Insufficient permissions', 403);
  }

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
  await ensureDefaultGroups();
  return updated ? toPublicUser(updated) : undefined;
}

export function extractTokenFromRequest(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return undefined;
}
