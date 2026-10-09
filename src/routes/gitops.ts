import { Router } from 'express';
import { z } from 'zod';
import {
  loadGitOpsRuntime,
  loadGitOpsSettings,
  saveGitOpsSettings,
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
import type { GitOpsSettings } from '../types/gitops';
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
  pathPrefix: z.string().default(''),
  syncIntervalSec: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

router.get('/gitops/status', async (req, res) => {
  const status = await loadGitOpsRuntime();
  const access = await accessForRequest(req);
  const items = await listInfrastructures();
  const scoped = access ? filterInfrastructuresByAccess(access, items) : items;
  const gitTracked = scoped.filter((i) => !!i.gitPath);
  res.json({
    ...status,
    trackedCount: gitTracked.length,
    infrastructures: gitTracked.map((i) => ({
      id: i.id,
      name: i.name,
      gitPath: i.gitPath,
      gitCommit: i.gitCommit,
      gitContentHash: i.gitContentHash,
      lastAppliedHash: i.lastAppliedHash,
      status: i.status,
      desiredAhead: !!(i.gitContentHash && i.gitContentHash !== i.lastAppliedHash),
    })),
  });
});

router.get('/gitops/settings', async (_req, res) => {
  res.json((await loadGitOpsSettings()) || null);
});

router.put('/gitops/settings', requireRole('admin'), async (req, res) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }
  const body = parsed.data;
  const settings: GitOpsSettings = {
    repoUrl: body.repoUrl,
    branch: body.branch,
    pathPrefix: body.pathPrefix,
    syncIntervalSec: body.syncIntervalSec,
    enabled: body.enabled,
    updatedAt: new Date().toISOString(),
  };
  await saveGitOpsSettings(settings);
  await recordAudit({
    action: 'gitops.settings.update',
    actor: getActorEmail(req),
    actorRole: getActorRole(req),
    summary: `Updated GitOps settings (${settings.repoUrl} @ ${settings.branch})`,
    resourceType: 'gitops',
    details: {
      branch: settings.branch,
      pathPrefix: settings.pathPrefix,
      syncIntervalSec: settings.syncIntervalSec,
      enabled: settings.enabled,
    },
  });
  res.json(settings);
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
