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
import type { GitOpsSettings } from '../types/gitops';

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
  res.json(settings);
});

router.post('/gitops/sync', async (_req, res) => {
  try {
    const result = await syncGitOpsRepo({ ifBusy: 'fail' });
    res.json(result);
  } catch (err) {
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
    res.json(report);
  } catch (err) {
    res.status(500).json({
      code: 'drift_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
