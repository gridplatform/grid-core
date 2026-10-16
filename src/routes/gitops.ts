import path from 'path';
import { Router } from 'express';
import { z } from 'zod';
import {
  loadGitOpsRuntime,
  loadGitOpsSettings,
  normalizeAndSaveGitOpsSettings,
  publicGitOpsSettings,
} from '../store/gitopsStore';
import {
  GitOpsSyncInProgressError,
  syncGitOpsRepo,
} from '../services/gitopsSyncService';
import { checkInfrastructureDrift } from '../services/driftService';
import { getInfrastructure, listInfrastructures } from '../store/memoryStore';
import {
  getModuleBankStatus,
  listModuleBankVersions,
  saveModuleBankSettings,
  syncModuleBank,
} from '../services/moduleBankService';
import { resolveResourceType } from '../services/resourceType';
import type { GitOpsSettings } from '../types/gitops';
import { redactGitRemoteUrl } from '../lib/gitRemoteAuth';
import { getActorEmail, getActorRole, requireRole } from '../middleware/requireAuth';
import { recordAudit } from '../services/auditStore';
import {
  accessForRequest,
  assertInfrastructureAccess,
  filterInfrastructuresByAccess,
} from '../services/accessFilter';
import { sendError } from '../lib/httpError';

const router = Router();

const SettingsSchema = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().min(1).default('main'),
  pathPrefix: z
    .string()
    .default('')
    .refine(
      (p) => !p || (!path.isAbsolute(p) && !p.split(/[/\\]/).includes('..')),
      { message: 'pathPrefix must be a relative path without .. segments' }
    ),
  syncIntervalSec: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  /** HTTPS username (optional). Omit to keep; empty string clears override. */
  username: z.string().optional(),
  /**
   * Write-only host-issued PAT / deploy token / app password (Grid does not mint these).
   * Omit / empty = keep existing; send clearAuth: true to remove.
   */
  token: z.string().optional(),
  /**
   * When that host token expires (`YYYY-MM-DD`). Required in the console when setting a new token.
   * Empty string clears; omit keeps existing when not rotating.
   */
  tokenExpiresAt: z.string().optional(),
  clearAuth: z.boolean().optional(),
});

/** True when desired-state content has not been applied yet. */
function isDesiredAhead(infra: {
  status: string;
  gitContentHash?: string;
  lastAppliedHash?: string;
}): boolean {
  if (infra.status === 'stale' || infra.status === 'destroyed') return false;
  return !!(
    infra.gitContentHash &&
    infra.gitContentHash !== infra.lastAppliedHash
  );
}

/** Keep stored URL when the client posts a redacted placeholder unchanged. */
function resolveRepoUrlInput(
  incoming: string,
  existing: string | undefined
): { ok: true; repoUrl: string } | { ok: false; message: string } {
  if (!incoming.includes('***')) {
    return { ok: true, repoUrl: incoming };
  }
  const redactedExisting = existing ? redactGitRemoteUrl(existing) : undefined;
  if (existing && redactedExisting === incoming) {
    return { ok: true, repoUrl: existing };
  }
  return {
    ok: false,
    message:
      'Re-enter the repository URL to change it. Redacted placeholders cannot be saved.',
  };
}

router.get('/gitops/status', async (req, res) => {
  const status = await loadGitOpsRuntime();
  const access = await accessForRequest(req);
  const items = await listInfrastructures();
  const scoped = access ? filterInfrastructuresByAccess(access, items) : items;
  const gitTracked = scoped.filter((i) => !!i.gitPath);
  res.json({
    ...status,
    clonePath: undefined,
    trackedCount: gitTracked.length,
    infrastructures: gitTracked.map((i) => ({
      id: i.id,
      name: i.name,
      provider: i.provider,
      type: resolveResourceType({
        configJson: i.configJson,
        gitPath: i.gitPath,
        name: i.name,
      }),
      project: i.project,
      environment: i.environment,
      gitPath: i.gitPath,
      gitCommit: i.gitCommit,
      gitContentHash: i.gitContentHash,
      lastAppliedHash: i.lastAppliedHash,
      status: i.status,
      desiredAhead: isDesiredAhead(i),
    })),
  });
});

router.get('/gitops/settings', requireRole('admin'), async (_req, res) => {
  const settings = await loadGitOpsSettings();
  if (!settings) {
    res.json(null);
    return;
  }
  res.json(await publicGitOpsSettings(settings));
});

router.put('/gitops/settings', requireRole('admin'), async (req, res) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }
  const body = parsed.data;
  const existing = await loadGitOpsSettings();
  const resolved = resolveRepoUrlInput(body.repoUrl, existing?.repoUrl);
  if (!resolved.ok) {
    res.status(400).json({ code: 'validation_error', message: resolved.message });
    return;
  }
  const settings: GitOpsSettings = {
    repoUrl: resolved.repoUrl,
    branch: body.branch,
    pathPrefix: body.pathPrefix,
    syncIntervalSec: body.syncIntervalSec,
    enabled: body.enabled,
    updatedAt: new Date().toISOString(),
  };

  let tokenOpt: string | null | undefined = undefined;
  let usernameOpt: string | null | undefined = undefined;
  let expiresOpt: string | null | undefined = undefined;
  if (body.clearAuth) {
    tokenOpt = null;
    usernameOpt = null;
    expiresOpt = null;
  } else {
    if (typeof body.token === 'string' && body.token.length > 0) {
      tokenOpt = body.token;
      const exp = body.tokenExpiresAt?.trim();
      if (!exp) {
        res.status(400).json({
          code: 'validation_error',
          message:
            'tokenExpiresAt (YYYY-MM-DD) is required when setting a new HTTPS token — use the expiry from your Git host.',
        });
        return;
      }
      expiresOpt = exp;
      const user =
        typeof body.username === 'string' ? body.username.trim() : '';
      if (!user) {
        res.status(400).json({
          code: 'validation_error',
          message:
            'username is required when setting a new HTTPS token (e.g. git, oauth2, x-token-auth).',
        });
        return;
      }
      usernameOpt = user;
    } else if (body.username !== undefined) {
      usernameOpt = body.username.trim() === '' ? null : body.username;
    }
    if (body.tokenExpiresAt !== undefined && tokenOpt === undefined) {
      expiresOpt = body.tokenExpiresAt.trim() === '' ? null : body.tokenExpiresAt;
    }
  }

  const saved = await normalizeAndSaveGitOpsSettings(settings, {
    token: tokenOpt,
    username: usernameOpt,
    tokenExpiresAt: expiresOpt,
  });
  const published = await publicGitOpsSettings(saved);
  await recordAudit({
    action: 'gitops.settings.update',
    actor: getActorEmail(req),
    actorRole: getActorRole(req),
    summary: `Updated GitOps settings (${published.repoUrl} @ ${saved.branch})`,
    resourceType: 'gitops',
    details: {
      branch: saved.branch,
      pathPrefix: saved.pathPrefix,
      syncIntervalSec: saved.syncIntervalSec,
      enabled: saved.enabled,
      authConfigured: published.authConfigured === true,
      authExpiresAt: published.authExpiresAt,
      authRotated: Boolean(body.clearAuth || (body.token && body.token.length > 0)),
    },
  });
  res.json(published);
});

router.post('/gitops/sync', requireRole('admin'), async (req, res) => {
  try {
    const result = await syncGitOpsRepo({ ifBusy: 'fail' });
    if (!result) {
      res.status(409).json({
        code: 'gitops_sync_in_progress',
        message: 'GitOps sync is already in progress',
      });
      return;
    }
    await recordAudit({
      action: 'gitops.sync',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: `Synced desired-state (${result.synced} files)`,
      resourceType: 'gitops',
      details: result as unknown as Record<string, unknown>,
    });
    res.json(result);
  } catch (err) {
    await recordAudit({
      action: 'gitops.sync',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: `GitOps sync failed: ${err instanceof Error ? err.message : String(err)}`,
      resourceType: 'gitops',
      outcome: 'failure',
    });
    if (err instanceof GitOpsSyncInProgressError) {
      res.status(409).json({
        code: 'gitops_sync_in_progress',
        message: err.message,
      });
      return;
    }
    sendError(res, err);
  }
});

router.post('/gitops/infrastructures/:id/drift-check', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  try {
    await assertInfrastructureAccess(req, infra);
    const report = await checkInfrastructureDrift(infra);
    await recordAudit({
      action: 'infra.drift_check',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: `Drift check: ${infra.name} — ${report.summary}`,
      resourceType: 'infrastructure',
      resourceId: infra.id,
      resourceName: infra.name,
      details: { hasDrift: report.hasDrift, kind: report.kind },
    });
    res.json(report);
  } catch (err) {
    sendError(res, err);
  }
});

/** Module bank (grid-terraform) — separate from desired-state GitOps. */
router.get('/module-bank/status', async (_req, res) => {
  res.json(await getModuleBankStatus({ includeVersions: true }));
});

router.get('/module-bank/versions', async (_req, res) => {
  try {
    const versions = await listModuleBankVersions(true);
    res.json({ versions, active: (await getModuleBankStatus({ includeVersions: false })).version });
  } catch (err) {
    sendError(res, err);
  }
});

const ModuleBankSettingsSchema = z.object({
  version: z.string().min(1).max(200).optional(),
  syncIntervalSec: z.number().int().min(0).max(86400).optional(),
});

/** Admin: set active module bank version and/or auto-sync interval. */
router.patch('/module-bank/settings', requireRole('admin'), async (req, res) => {
  try {
    const body = ModuleBankSettingsSchema.parse(req.body ?? {});
    if (body.version === undefined && body.syncIntervalSec === undefined) {
      res.status(400).json({
        code: 'validation_error',
        message: 'Provide version and/or syncIntervalSec',
      });
      return;
    }
    const settings = await saveModuleBankSettings(body);
    // Sync immediately when version changes so local checkout matches git:: ref.
    let status = await getModuleBankStatus({ includeVersions: true });
    if (body.version !== undefined) {
      status = await syncModuleBank();
    }
    await recordAudit({
      action: 'module_bank.settings',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: `Module bank settings updated (version=${settings.version}, interval=${settings.syncIntervalSec}s)`,
      resourceType: 'module_bank',
      details: { settings, status: status as unknown as Record<string, unknown> },
    });
    res.json({ settings, status });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ code: 'validation_error', message: err.message });
      return;
    }
    sendError(res, err);
  }
});

router.post('/module-bank/sync', requireRole('admin'), async (req, res) => {
  try {
    // Optional body.version — set active version then sync.
    const body = ModuleBankSettingsSchema.partial().safeParse(req.body ?? {});
    if (body.success && body.data.version) {
      await saveModuleBankSettings({ version: body.data.version });
    }
    const status = await syncModuleBank();
    await recordAudit({
      action: 'module_bank.sync',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: `Synced module bank version ${status.version}`,
      resourceType: 'module_bank',
      details: status as unknown as Record<string, unknown>,
    });
    res.json(status);
  } catch (err) {
    await recordAudit({
      action: 'module_bank.sync',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: `Module bank sync failed: ${err instanceof Error ? err.message : String(err)}`,
      resourceType: 'module_bank',
      outcome: 'failure',
    });
    sendError(res, err);
  }
});

export default router;
