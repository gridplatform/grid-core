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
  syncModuleBank,
} from '../services/moduleBankService';
import type { GitOpsSettings } from '../types/gitops';
import { getActorEmail, getActorRole } from '../middleware/requireAuth';
import { recordAudit } from '../services/auditStore';

const router = Router();

const SettingsSchema = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().min(1).default('main'),
  pathPrefix: z.string().default(''),
  syncIntervalSec: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

router.get('/gitops/status', async (_req, res) => {
  const status = await loadGitOpsRuntime();
  const items = await listInfrastructures();
  const gitTracked = items.filter((i) => !!i.gitPath);
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

router.put('/gitops/settings', async (req, res) => {
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

router.post('/gitops/sync', async (req, res) => {
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
    res.status(400).json({
      code: 'gitops_sync_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post('/gitops/infrastructures/:id/drift-check', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  try {
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
    res.status(500).json({
      code: 'drift_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Module bank (grid-terraform) — separate from desired-state GitOps. */
router.get('/module-bank/status', async (_req, res) => {
  res.json(await getModuleBankStatus());
});

router.post('/module-bank/sync', async (req, res) => {
  try {
    const status = await syncModuleBank();
    await recordAudit({
      action: 'module_bank.sync',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: 'Synced module bank (grid-terraform)',
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
    res.status(400).json({
      code: 'module_bank_sync_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
