import type { Request } from 'express';
import type { Infrastructure } from '../types/api';
import { AccessError } from '../lib/httpError';
import {
  assertDomainAccess,
  canAccessEnvironment,
  canAccessProject,
  canAccessWorkspacePair,
  resolveAccessForUser,
  type AccessContext,
  type EffectiveAccess,
} from './accessService';

/** Resolve access for the authenticated request (optional project×env context). */
export async function accessForRequest(
  req: Request,
  ctx?: AccessContext
): Promise<EffectiveAccess | null> {
  const user = req.gridUser;
  if (!user) return null;
  return resolveAccessForUser(user, ctx);
}

/** Throw 403 if the unit is outside the caller's workspace grants. */
export async function assertInfrastructureAccess(
  req: Request,
  infra: Pick<Infrastructure, 'id' | 'name' | 'project' | 'environment'>
): Promise<EffectiveAccess | null> {
  const ctx = { project: infra.project, environment: infra.environment };
  const access = await accessForRequest(req, ctx);
  if (!access) return null;
  if (!canAccessWorkspacePair(access.workspace, infra.project, infra.environment)) {
    throw new AccessError(`No access to infrastructure “${infra.name}”`, {
      infrastructureId: infra.id,
      project: infra.project,
      environment: infra.environment,
    });
  }
  return access;
}

/**
 * Workspace visibility + infrastructure write for mutate / deploy paths.
 * Call on create, patch, clone, and deployment entrypoints.
 */
export async function assertInfrastructureWrite(
  req: Request,
  infra: Pick<Infrastructure, 'id' | 'name' | 'project' | 'environment'>,
  actionLabel = 'modify infrastructure'
): Promise<EffectiveAccess | null> {
  const access = await assertInfrastructureAccess(req, infra);
  if (!access) return null;
  assertDomainAccess(
    access,
    'infrastructure',
    'write',
    actionLabel,
    { project: infra.project, environment: infra.environment }
  );
  return access;
}

/** Workspace + write for a project×environment before creating a new unit. */
export async function assertInfrastructureCreate(
  req: Request,
  ctx: { project?: string; environment: string },
  actionLabel = 'create infrastructure'
): Promise<EffectiveAccess | null> {
  const access = await accessForRequest(req, ctx);
  if (!access) return null;
  assertDomainAccess(access, 'infrastructure', 'write', actionLabel, ctx);
  return access;
}

export function filterProjectsByAccess<T extends { slug: string }>(
  access: EffectiveAccess,
  projects: T[]
): T[] {
  return projects.filter((p) => canAccessProject(access.workspace, p.slug));
}

export function filterEnvironmentsByAccess<T extends { slug: string }>(
  access: EffectiveAccess,
  environments: T[],
  projectSlug?: string
): T[] {
  if (projectSlug) {
    return environments.filter((e) =>
      canAccessEnvironment(access.workspace, projectSlug, e.slug)
    );
  }

  // No project context (e.g. global search): env is visible if any allowed
  // project grant includes it.
  if (access.workspace.mode === 'global' || access.workspace.projects.includes('*')) {
    const star = access.workspace.environments['*'] || [];
    if (star.includes('*')) return environments;
    if (star.length) {
      const allow = new Set(star);
      return environments.filter((e) => allow.has(e.slug.toLowerCase()));
    }
  }

  const allowed = new Set<string>();
  let allEnvs = false;
  for (const [proj, envs] of Object.entries(access.workspace.environments)) {
    if (
      proj !== '*' &&
      !access.workspace.projects.includes('*') &&
      !access.workspace.projects.includes(proj)
    ) {
      continue;
    }
    if (envs.includes('*')) {
      allEnvs = true;
      break;
    }
    for (const env of envs) allowed.add(env);
  }
  if (allEnvs) return environments;
  return environments.filter((e) => allowed.has(e.slug.toLowerCase()));
}

export function filterInfrastructuresByAccess<T extends Pick<Infrastructure, 'project' | 'environment'>>(
  access: EffectiveAccess,
  items: T[]
): T[] {
  return items.filter((i) =>
    canAccessWorkspacePair(access.workspace, i.project, i.environment)
  );
}
