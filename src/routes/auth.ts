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
import { recordAudit } from '../services/auditStore';
import { createCustomGroup, listGroups, updateCustomGroupPermissions } from '../store/groupStore';
import { ACCESS_DOMAIN_CATALOG, ASSIGNABLE_ROLES, PREDEFINED_ACCESS_ROLES } from '../auth/rbac';
import { resolveAccessByEmail, resolveAccessForUser } from '../services/accessService';

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
  /** Default: member = no access until admin/superadmin assigns a role or custom group. */
  role: z.enum(['developer', 'maintainer', 'admin', 'member']).default('member'),
});

const PatchUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['developer', 'maintainer', 'admin', 'member']).optional(),
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

router.get('/auth/me', async (req, res) => {
  if (config.auth.disabled) {
    const user = demoUserAsPublic();
    const access = await resolveAccessByEmail(user.email);
    res.json({ ...user, access });
    return;
  }
  if (!req.gridUser) {
    res.status(401).json({ code: 'unauthorized', message: 'Not authenticated' });
    return;
  }
  const access = await resolveAccessForUser(req.gridUser);
  res.json({ ...req.gridUser, access });
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
    await recordAudit({
      action: 'auth.login',
      actor: result.user.email,
      actorRole: result.user.role,
      summary: `User signed in: ${result.user.email}`,
      resourceType: 'user',
      resourceId: result.user.id,
    });
    res.json(result);
  } catch (err) {
    await recordAudit({
      action: 'auth.login',
      actor: parsed.data.email,
      summary: `Failed sign-in for ${parsed.data.email}`,
      outcome: 'failure',
    });
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
    await recordAudit({
      action: 'auth.register',
      actor: user.email,
      actorRole: user.role,
      summary: `Registered user: ${user.email}`,
      resourceType: 'user',
      resourceId: user.id,
    });
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
  const actor = getActorEmail(req);
  if (!config.auth.disabled) {
    const bearer = extractTokenFromRequest(req.header('authorization'));
    await logout(bearer);
  }
  await recordAudit({
    action: 'auth.logout',
    actor,
    summary: `User signed out: ${actor}`,
  });
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
    await recordAudit({
      action: 'auth.user.create',
      actor: getActorEmail(req),
      actorRole: req.gridUser?.role,
      summary: `Admin created user ${user.email} (${user.role})`,
      resourceType: 'user',
      resourceId: user.id,
      resourceName: user.email,
      details: { role: user.role },
    });
    res.status(201).json({ user });
  } catch (err) {
    sendAuthError(res, err);
  }
});

router.patch('/auth/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const body = PatchUserSchema.parse(req.body);
    const user = await adminPatchUser(req.params.id, body, req.gridUser);
    if (!user) {
      res.status(404).json({ code: 'not_found', message: 'User not found' });
      return;
    }
    await recordAudit({
      action: 'auth.user.update',
      actor: getActorEmail(req),
      actorRole: req.gridUser?.role,
      summary: `Admin updated user ${user.email}`,
      resourceType: 'user',
      resourceId: user.id,
      resourceName: user.email,
      details: body as Record<string, unknown>,
    });
    res.json({ user });
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** Built-in + custom groups. */
router.get('/auth/groups', requireRole('admin'), async (_req, res) => {
  const groups = await listGroups();
  res.json({
    groups,
    assignableRoles: ASSIGNABLE_ROLES,
    predefinedAccessRoles: PREDEFINED_ACCESS_ROLES,
    domainCatalog: ACCESS_DOMAIN_CATALOG,
    accessModel: {
      levels: {
        none: 'No access',
        read: 'Plan / view (UI view-only for observability surfaces)',
        write: 'Apply / destroy / manage (implies read)',
      },
      grantShape: {
        projects: 'Project slugs or ["*"] for all',
        environments: 'Environment slugs or ["*"] for all',
        domains:
          'Map of domain id → none|read|write (infrastructure, kubernetes, monitoring, apm, logs, topology, secrets, …)',
      },
      notes: [
        'New users start as member (no access).',
        'Admin or superadmin assigns either a predefined role (developer / maintainer / admin) or a custom group.',
        'Predefined roles grant global access to all projects, environments, and domains.',
        'Custom groups use grants: project × environment × domains (extensible catalog).',
        'Only superadmin may bypass environment approval.',
        'Write granted via a custom group always requires approval.',
      ],
    },
  });
});

const AccessLevelSchema = z.enum(['none', 'read', 'write']);

/** Any domain id → level (infrastructure, kubernetes, monitoring, … plus future keys). */
const DomainMapSchema = z.record(AccessLevelSchema);

const GrantSchema = z.object({
  projects: z.array(z.string()).min(1),
  environments: z.array(z.string()).min(1),
  domains: DomainMapSchema,
});

const CreateGroupSchema = z.object({
  slug: z.string().min(1).max(48),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** Preferred: list of project × environment × domain grants. */
  grants: z.array(GrantSchema).optional(),
  /** Shorthand: single grant built from projects + environments + domains. */
  projects: z.array(z.string()).optional(),
  environments: z.array(z.string()).optional(),
  domains: DomainMapSchema.optional(),
  memberUserIds: z.array(z.string()).optional(),
});

const PatchGroupSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  grants: z.array(GrantSchema).optional(),
  projects: z.array(z.string()).optional(),
  environments: z.array(z.string()).optional(),
  domains: DomainMapSchema.optional(),
  memberUserIds: z.array(z.string()).optional(),
});

router.post('/auth/groups', requireRole('admin'), async (req, res) => {
  try {
    const body = CreateGroupSchema.parse(req.body);
    const group = await createCustomGroup(body);
    await recordAudit({
      action: 'auth.group.create',
      actor: getActorEmail(req),
      actorRole: req.gridUser?.role,
      summary: `Created custom group ${group.slug}`,
      resourceType: 'group',
      resourceId: group.id,
      resourceName: group.slug,
    });
    res.status(201).json({ group });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ code: 'group_error', message });
  }
});

router.patch('/auth/groups/:slug', requireRole('admin'), async (req, res) => {
  try {
    const body = PatchGroupSchema.parse(req.body);
    const group = await updateCustomGroupPermissions(req.params.slug, body);
    await recordAudit({
      action: 'auth.group.update',
      actor: getActorEmail(req),
      actorRole: req.gridUser?.role,
      summary: `Updated group ${group.slug}`,
      resourceType: 'group',
      resourceId: group.id,
      resourceName: group.slug,
    });
    res.json({ group });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found') ? 404 : 400;
    res.status(code).json({ code: code === 404 ? 'not_found' : 'group_error', message });
  }
});

export default router;
