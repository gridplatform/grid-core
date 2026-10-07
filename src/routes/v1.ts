import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import {
  createDeployment,
  createInfrastructure,
  getDeployment,
  getInfrastructure,
  listDeployments,
  listInfrastructures,
  cancelActiveDeploymentsForInfrastructure,
  reconcileDeployments,
  saveDeployment,
  saveInfrastructure,
} from '../store/memoryStore';
import { runLifecycle } from '../services/lifecycleService';
import { buildTopologyFromInfrastructures } from '../services/topologyService';
import { listEnvironmentsFromConfig } from '../services/environmentsService';
import { listProjectsFromConfig } from '../services/projectsService';
import {
  restoreInfrastructureToConfig,
  syncInfrastructuresFromConfigRoot,
} from '../services/configRootSync';
import {
  enqueueRelease,
  cancelRelease,
  listPendingApprovals,
  approveRelease,
  rejectRelease,
} from '../services/releaseService';
import { setApprovalRequired } from '../services/approvalPolicyStore';
import { getRelease, listReleases } from '../services/releaseStore';
import {
  DeployMapError,
  mapDeployRequestToGridConfig,
} from '../services/gridConfigMapper';
import type {
  CloudProviderType,
  Infrastructure,
  InfrastructureListItem,
  LifecycleMode,
} from '../types/api';
import { getActorEmail, getActorRole, requireRole } from '../middleware/requireAuth';
import { resolveResourceType } from '../services/resourceType';
import { listAuditEvents, recordAudit } from '../services/auditStore';
import {
  getInfraHealth,
  getInfraMetrics,
  listInventoryAlerts,
  listMonitoringDashboards,
} from '../services/monitoringService';
import { getSystemVersionInfo } from '../services/systemInfoService';

const router = Router();

const CreateInfraSchema = z.object({
  name: z.string().min(1),
  environment: z.string().default('dev'),
  provider: z.string().default('AWS'),
  configJson: z.record(z.unknown()),
  autoApprove: z.boolean().optional(),
  driftDetection: z.boolean().optional(),
});

const PatchInfraSchema = z.object({
  name: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  configJson: z.record(z.unknown()).optional(),
  autoApprove: z.boolean().optional(),
  driftDetection: z.boolean().optional(),
});

const CreateDeploymentSchema = z.object({
  name: z.string().min(1),
  engine: z.enum(['terraform', 'kubernetes']),
  provider: z.string().optional(),
  environment: z.string().min(1),
  resourceType: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  infrastructureId: z.string().uuid().optional(),
  mode: z.enum(['plan', 'apply']).default('apply'),
});

function toListItem(infra: Awaited<ReturnType<typeof getInfrastructure>>): InfrastructureListItem | null {
  if (!infra) return null;
  const cfg = infra.configJson as { region?: string; provider?: string } | undefined;
  return {
    id: infra.id,
    name: infra.name,
    type: resolveResourceType({
      configJson: infra.configJson,
      gitPath: infra.gitPath,
      name: infra.name,
    }),
    status: infra.status,
    region: (cfg && typeof cfg.region === 'string' && cfg.region) || 'ap-south-1',
    environment: infra.environment,
    provider: infra.provider,
    project: infra.project,
    connections: [],
    gitPath: infra.gitPath,
    // Full configJson stays on GET /infrastructures/:id.
  };
}

async function startLifecycle(
  infra: Infrastructure,
  mode: LifecycleMode,
  triggeredBy: string,
  meta?: { name?: string; engine?: string; resourceType?: string; provider?: string; environment?: string }
) {
  await cancelActiveDeploymentsForInfrastructure(infra.id);
  const deployment = await createDeployment(infra.id, triggeredBy, {
    name: meta?.name || infra.name,
    engine: meta?.engine || 'terraform',
    resourceType: meta?.resourceType,
    provider: meta?.provider || infra.provider,
    environment: meta?.environment || infra.environment,
    mode,
  });
  void runLifecycle(infra, deployment, mode);
  return deployment;
}

router.get('/health', async (_req, res) => {
  const info = await getSystemVersionInfo();
  res.json({
    status: 'ok',
    service: 'grid-core',
    version: info.core.version,
  });
});

/** Running component versions for the control plane. */
router.get('/system/version', async (_req, res) => {
  res.json(await getSystemVersionInfo());
});

router.get('/infrastructures', async (req, res) => {
  const existing = await listInfrastructures();
  if (existing.length === 0) {
    // First load — must populate from desired-state tree.
    await syncInfrastructuresFromConfigRoot({ force: true });
  } else {
    // Refresh in background when TTL allows; do not block the UI.
    void syncInfrastructuresFromConfigRoot();
  }

  const project =
    typeof req.query.project === 'string' && req.query.project.trim()
      ? req.query.project.trim()
      : undefined;
  const environment =
    typeof req.query.environment === 'string' && req.query.environment.trim()
      ? req.query.environment.trim()
      : undefined;

  const items = await listInfrastructures();
  // Config-backed units + stale (removed from config, still in state). Never list destroyed orphans.
  res.json(
    items
      .filter((i) => i.status !== 'destroyed')
      .filter((i) => {
        if (project && (i.project || 'demo-app') !== project) return false;
        if (environment && i.environment !== environment) return false;
        return true;
      })
      .map((i) => toListItem(i))
      .filter(Boolean)
  );
});

router.get('/infrastructures/:id', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  res.json(infra);
});

router.post('/infrastructures', async (req, res) => {
  const parsed = CreateInfraSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const body = parsed.data;
  const provider = body.provider as CloudProviderType;
  const infra = await createInfrastructure({
    name: body.name,
    environment: body.environment,
    provider,
    configJson: body.configJson,
    status: 'pending',
    autoApprove: body.autoApprove ?? true,
    driftDetection: body.driftDetection ?? false,
  });

  await recordAudit({
    action: 'infra.create',
    actor: getActorEmail(req),
    actorRole: getActorRole(req),
    summary: `Created infrastructure ${infra.name}`,
    resourceType: 'infrastructure',
    resourceId: infra.id,
    resourceName: infra.name,
    details: { environment: infra.environment, provider: infra.provider },
  });

  const shouldApply = req.query.apply === 'true' || req.query.apply === '1';
  const shouldPlan = req.query.plan === 'true' || req.query.plan === '1';

  if (shouldApply || shouldPlan) {
    const deployment = await startLifecycle(
      infra,
      shouldApply ? 'apply' : 'plan',
      getActorEmail(req)
    );
    res.status(201).json({ infrastructure: infra, deployment });
    return;
  }

  res.status(201).json(infra);
});

router.patch('/infrastructures/:id', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  if (infra.status === 'destroyed') {
    res.status(409).json({ code: 'destroyed', message: 'Infrastructure was destroyed; create a new one' });
    return;
  }

  const parsed = PatchInfraSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const body = parsed.data;
  if (body.name !== undefined) infra.name = body.name;
  if (body.environment !== undefined) infra.environment = body.environment;
  if (body.configJson !== undefined) infra.configJson = body.configJson;
  if (body.autoApprove !== undefined) infra.autoApprove = body.autoApprove;
  if (body.driftDetection !== undefined) infra.driftDetection = body.driftDetection;
  infra.updatedAt = new Date().toISOString();
  await saveInfrastructure(infra);
  await recordAudit({
    action: 'infra.update',
    actor: getActorEmail(req),
    actorRole: getActorRole(req),
    summary: `Updated infrastructure ${infra.name}`,
    resourceType: 'infrastructure',
    resourceId: infra.id,
    resourceName: infra.name,
  });
  res.json(infra);
});

router.post('/infrastructures/:id/plan', async (req, res) => {
  await enqueueInfrastructureRelease(req, res, 'plan');
});

router.post('/infrastructures/:id/apply', async (req, res) => {
  await enqueueInfrastructureRelease(req, res, 'apply');
});

router.post('/infrastructures/:id/destroy', async (req, res) => {
  await enqueueInfrastructureRelease(req, res, 'destroy');
});

async function enqueueInfrastructureRelease(
  req: Request,
  res: Response,
  mode: 'plan' | 'apply' | 'destroy'
) {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  if (infra.status === 'destroyed') {
    res.status(409).json({
      code: 'destroyed',
      message: mode === 'destroy' ? 'Already destroyed' : 'Infrastructure was destroyed',
    });
    return;
  }
  if (mode === 'destroy' && req.gridUser?.role !== 'admin') {
    res.status(403).json({
      code: 'forbidden',
      message: 'Only admins can destroy infrastructure',
    });
    return;
  }
  try {
    const release = await enqueueRelease({
      name: `${infra.name} (${mode})`,
      environment: infra.environment,
      mode,
      infrastructureId: infra.id,
      createdBy: getActorEmail(req),
    });
    res.status(201).json(release);
  } catch (err) {
    res.status(400).json({
      code: 'release_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Restore a stale unit: write configJson back to gitPath under GRID_CONFIG_ROOT.
 * Use when JSON was removed but cloud state still exists and the operator wants the config again.
 */
router.post('/infrastructures/:id/restore-config', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  if (infra.status !== 'stale') {
    res.status(409).json({
      code: 'not_stale',
      message: 'Only stale infrastructures (removed from config but still in state) can be restored',
    });
    return;
  }
  try {
    const restored = await restoreInfrastructureToConfig(infra);
    await recordAudit({
      action: 'infra.restore_config',
      actor: getActorEmail(req),
      actorRole: getActorRole(req),
      summary: `Restored config for ${restored.name}`,
      resourceType: 'infrastructure',
      resourceId: restored.id,
      resourceName: restored.name,
      details: { gitPath: restored.gitPath },
    });
    res.json(restored);
  } catch (err) {
    res.status(500).json({
      code: 'restore_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Legacy alias for apply — still creates an apply release */
router.post('/infrastructures/:id/deploy', async (req, res) => {
  await enqueueInfrastructureRelease(req, res, 'apply');
});

router.post('/infrastructures/:id/drift-check', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  try {
    const { checkInfrastructureDrift } = await import('../services/driftService');
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

router.post('/infrastructures/:id/clone', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  const clone = await createInfrastructure({
    ...infra,
    name: `${infra.name}-clone`,
    status: 'pending',
  });
  res.status(201).json(clone);
});

/** DELETE enqueues a destroy release (admin only) */
router.delete('/infrastructures/:id', async (req, res) => {
  await enqueueInfrastructureRelease(req, res, 'destroy');
});

router.get('/audit', requireRole('admin'), async (req, res) => {
  const raw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(raw) ? raw : 200;
  res.json(await listAuditEvents(limit));
});

router.get('/deployments', async (_req, res) => {
  void syncInfrastructuresFromConfigRoot();
  await reconcileDeployments();
  res.json(await listDeployments());
});

router.post('/deployments', async (req, res) => {
  const parsed = CreateDeploymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const body = parsed.data;
  if (body.engine === 'kubernetes') {
    res.status(501).json({
      code: 'not_implemented',
      message: 'Kubernetes workloads are not applied yet. Use engine=terraform for infrastructure.',
    });
    return;
  }

  let mapped;
  try {
    mapped = mapDeployRequestToGridConfig(body);
  } catch (err) {
    if (err instanceof DeployMapError) {
      res.status(err.statusCode).json({ code: 'deploy_map_error', message: err.message });
      return;
    }
    throw err;
  }

  let infra: Infrastructure;
  if (body.infrastructureId) {
    const existing = await getInfrastructure(body.infrastructureId);
    if (!existing) {
      res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
      return;
    }
    if (existing.status === 'destroyed') {
      res.status(409).json({ code: 'destroyed', message: 'Infrastructure was destroyed' });
      return;
    }
    existing.name = body.name;
    existing.environment = body.environment;
    existing.configJson = mapped.gridConfig;
    existing.provider = mapped.displayProvider;
    existing.updatedAt = new Date().toISOString();
    infra = await saveInfrastructure(existing);
  } else {
    infra = await createInfrastructure({
      name: body.name,
      environment: body.environment,
      provider: mapped.displayProvider,
      configJson: mapped.gridConfig,
      status: 'pending',
      autoApprove: true,
      driftDetection: false,
    });
  }

  const mode: LifecycleMode = body.mode;
  const deployment = await startLifecycle(infra, mode, getActorEmail(req), {
    name: body.name,
    engine: body.engine,
    resourceType: body.resourceType,
    provider: body.provider || String(mapped.gridConfig.provider),
    environment: body.environment,
  });

  res.status(202).json(deployment);
});

router.get('/deployments/:id', async (req, res) => {
  const d = await getDeployment(req.params.id);
  if (!d) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }
  res.json(d);
});

router.get('/deployments/:id/logs', async (req, res) => {
  const d = await getDeployment(req.params.id);
  if (!d) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }
  res.json({
    deploymentId: d.id,
    logs: d.logs,
    planSummary: d.planSummary,
    status: d.status,
    progress: d.progress,
    mode: d.mode,
  });
});

/** SSE stream of live CLI/terraform log lines. */
router.get('/deployments/:id/logs/stream', async (req, res) => {
  const initial = await getDeployment(req.params.id);
  if (!initial) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let cursor = 0;
  let closed = false;

  const writeEvent = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent('snapshot', {
    deploymentId: initial.id,
    logs: initial.logs,
    status: initial.status,
    progress: initial.progress,
    mode: initial.mode,
    planSummary: initial.planSummary,
  });
  cursor = initial.logs.length;

  const tick = async () => {
    if (closed) return;
    const d = await getDeployment(req.params.id);
    if (!d) {
      writeEvent('error', { message: 'Deployment not found' });
      cleanup();
      return;
    }

    if (d.logs.length > cursor) {
      const lines = d.logs.slice(cursor);
      cursor = d.logs.length;
      writeEvent('log', {
        lines,
        status: d.status,
        progress: d.progress,
        mode: d.mode,
      });
    } else {
      // Keep proxies from closing idle streams
      writeEvent('ping', { status: d.status, progress: d.progress });
    }

    const terminal = d.status === 'success' || d.status === 'failed' || d.status === 'cancelled';
    if (terminal) {
      writeEvent('done', {
        status: d.status,
        progress: d.progress,
        planSummary: d.planSummary,
        logs: d.logs,
      });
      cleanup();
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, 400);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    try {
      res.end();
    } catch {
      // ignore
    }
  };

  req.on('close', cleanup);
  void tick();
});

router.post('/deployments/:id/cancel', async (req, res) => {
  const d = await getDeployment(req.params.id);
  if (!d) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }
  if (d.status === 'running' || d.status === 'pending' || d.status === 'planning') {
    d.status = 'cancelled';
    d.completedAt = new Date().toISOString();
    await saveDeployment(d);
  }
  res.status(204).end();
});

router.post('/deployments/:id/retry', async (req, res) => {
  const d = await getDeployment(req.params.id);
  if (!d) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }
  const infra = await getInfrastructure(d.infrastructureId);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  const mode: LifecycleMode = d.mode === 'plan' || d.mode === 'destroy' ? d.mode : 'apply';
  const next = await startLifecycle(infra, mode, getActorEmail(req), {
    name: d.name || infra.name,
    engine: d.engine || 'terraform',
    resourceType: d.resourceType,
    provider: d.provider,
    environment: d.environment || infra.environment,
  });
  res.status(202).json(next);
});

router.get('/topology/providers', async (_req, res) => {
  const existing = await listInfrastructures();
  if (existing.length === 0) {
    await syncInfrastructuresFromConfigRoot({ force: true });
  } else {
    void syncInfrastructuresFromConfigRoot();
  }
  const items = (await listInfrastructures()).filter((i) => i.status !== 'destroyed');
  res.json(buildTopologyFromInfrastructures(items));
});

router.get('/topology/providers/:id/vpcs', async (req, res) => {
  void syncInfrastructuresFromConfigRoot();
  const items = (await listInfrastructures()).filter((i) => i.status !== 'destroyed');
  const providers = buildTopologyFromInfrastructures(items);
  const provider = providers.find((p) => p.id === req.params.id);
  res.json(provider?.vpcs || []);
});

router.get('/topology/vpcs/:id/resources', async (req, res) => {
  void syncInfrastructuresFromConfigRoot();
  const items = (await listInfrastructures()).filter((i) => i.status !== 'destroyed');
  const providers = buildTopologyFromInfrastructures(items);
  for (const p of providers) {
    const vpc = p.vpcs.find((v) => v.id === req.params.id);
    if (vpc) {
      res.json(vpc.resources);
      return;
    }
  }
  res.json([]);
});

router.get('/topology/vpcs/:id/connections', (_req, res) => {
  res.json([]);
});

const empty = (_req: unknown, res: { json: (b: unknown) => void }) => res.json([]);

const CreateReleaseSchema = z.object({
  name: z.string().min(1).optional(),
  environment: z.string().min(1),
  mode: z.enum(['plan', 'apply', 'destroy', 'custom']),
  infrastructureId: z.string().uuid().optional(),
  customCommand: z.string().optional(),
});

router.get('/releases', async (_req, res) => {
  res.json(await listReleases());
});

router.get('/releases/:id', async (req, res) => {
  const release = await getRelease(req.params.id);
  if (!release) {
    res.status(404).json({ code: 'not_found', message: 'Release not found' });
    return;
  }
  res.json(release);
});

router.post('/releases', async (req, res) => {
  const parsed = CreateReleaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }
  if (parsed.data.mode === 'destroy' && req.gridUser?.role !== 'admin') {
    res.status(403).json({
      code: 'forbidden',
      message: 'Only admins can create destroy releases',
    });
    return;
  }
  try {
    const release = await enqueueRelease({
      ...parsed.data,
      createdBy: getActorEmail(req),
    });
    res.status(201).json(release);
  } catch (err) {
    res.status(400).json({
      code: 'release_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post('/releases/:id/rollback', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Rollback not enabled yet' });
});

/** Admin: cancel queued release or kill deploying release (+ fail-safe terraform cleanup). */
router.post('/releases/:id/cancel', requireRole('admin'), async (req, res) => {
  try {
    const release = await cancelRelease(req.params.id, getActorEmail(req));
    res.json(release);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found')
      ? 404
      : message.includes('already')
        ? 409
        : 400;
    res.status(code).json({
      code: code === 404 ? 'not_found' : code === 409 ? 'conflict' : 'release_error',
      message,
    });
  }
});

router.get('/approvals', async (_req, res) => {
  res.json(await listPendingApprovals());
});

router.post(
  '/approvals/:id/approve',
  requireRole('maintainer', 'admin'),
  async (req, res) => {
    try {
      const comment =
        typeof req.body?.comment === 'string' ? req.body.comment : undefined;
      const approval = await approveRelease(req.params.id, getActorEmail(req), comment);
      res.json(approval);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('not found')
        ? 404
        : message.includes('own release')
          ? 403
          : 400;
      res.status(code).json({
        code: code === 404 ? 'not_found' : code === 403 ? 'forbidden' : 'approval_error',
        message,
      });
    }
  }
);

router.post(
  '/approvals/:id/reject',
  requireRole('maintainer', 'admin'),
  async (req, res) => {
    try {
      const comment =
        typeof req.body?.comment === 'string' ? req.body.comment : undefined;
      const approval = await rejectRelease(req.params.id, getActorEmail(req), comment);
      res.json(approval);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('not found') ? 404 : 400;
      res.status(code).json({
        code: code === 404 ? 'not_found' : 'approval_error',
        message,
      });
    }
  }
);

router.get('/clusters', empty);
router.post('/clusters/:id/scale', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Clusters not enabled' });
});

router.get('/monitoring/alerts', async (_req, res) => {
  res.json(await listInventoryAlerts());
});

router.get('/monitoring/metrics/:infra', async (req, res) => {
  const series = await getInfraMetrics(req.params.infra);
  if (!series) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  res.json(series);
});

router.post('/monitoring/alerts', (_req, res) => {
  res.status(501).json({
    code: 'not_implemented',
    message: 'Custom alert rules are not enabled; alerts are derived from inventory status',
  });
});

router.post('/monitoring/setup/:infra', (_req, res) => {
  res.status(501).json({
    code: 'not_implemented',
    message: 'External monitoring setup is not enabled; health is served from inventory',
  });
});

router.get('/monitoring/dashboards', async (_req, res) => {
  res.json(await listMonitoringDashboards());
});

router.get('/monitoring/health/:infra', async (req, res) => {
  const health = await getInfraHealth(req.params.infra);
  if (!health) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  res.json(health);
});

router.get('/apm/services', empty);
router.get('/apm/services/:id/operations', empty);
router.get('/apm/services/:serviceId/operations/:opId/traces', empty);
router.get('/apm/traces/:traceId', (_req, res) => {
  res.status(404).json({ code: 'not_found', message: 'Trace not found' });
});

router.get('/logs', empty);

router.get('/scaling/schedules', empty);
router.get('/scaling/policies', empty);

router.get('/environments', async (req, res) => {
  const project =
    typeof req.query.project === 'string' && req.query.project.trim()
      ? req.query.project.trim()
      : undefined;
  res.json(await listEnvironmentsFromConfig(project));
});

/** Admin: set whether apply/destroy/custom releases for an env require approval. */
router.patch(
  '/environments/:slug/approval',
  requireRole('admin'),
  async (req, res) => {
    const slug = req.params.slug?.trim();
    if (!slug) {
      res.status(400).json({ code: 'validation_error', message: 'Environment slug required' });
      return;
    }
    if (typeof req.body?.approvalRequired !== 'boolean') {
      res.status(400).json({
        code: 'validation_error',
        message: 'Body must include approvalRequired: boolean',
      });
      return;
    }
    try {
      const policy = await setApprovalRequired(
        slug,
        req.body.approvalRequired,
        getActorEmail(req)
      );
      try {
        await recordAudit({
          action: 'environment.approval_policy',
          actor: getActorEmail(req),
          actorRole: getActorRole(req),
          resourceType: 'environment',
          resourceId: slug,
          resourceName: slug,
          summary: `Set approvalRequired=${policy.approvalRequired} for ${slug}`,
          details: { approvalRequired: policy.approvalRequired },
        });
      } catch {
        /* ignore */
      }
      const environments = await listEnvironmentsFromConfig();
      const env = environments.find((e) => e.slug.toLowerCase() === slug.toLowerCase());
      res.json(env || { slug: policy.slug, approvalRequired: policy.approvalRequired });
    } catch (err) {
      res.status(400).json({
        code: 'policy_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
);

router.get('/projects', async (_req, res) => {
  res.json(await listProjectsFromConfig());
});

/** Lightweight search across projects / environments / infrastructures */
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase();
  if (!q) {
    res.json({ projects: [], environments: [], infrastructures: [] });
    return;
  }
  void syncInfrastructuresFromConfigRoot();
  const [projects, environments, infrastructures] = await Promise.all([
    listProjectsFromConfig(),
    listEnvironmentsFromConfig(),
    listInfrastructures(),
  ]);
  res.json({
    projects: projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        p.clouds.some((c) => c.toLowerCase().includes(q))
    ),
    environments: environments.filter(
      (e) => e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q)
    ),
    infrastructures: infrastructures
      .filter((i) => i.status !== 'destroyed')
      .filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.environment.toLowerCase().includes(q) ||
          (i.project || '').toLowerCase().includes(q) ||
          i.provider.toLowerCase().includes(q) ||
          (i.gitPath || '').toLowerCase().includes(q)
      )
      .slice(0, 40)
      .map((i) => ({
        id: i.id,
        name: i.name,
        environment: i.environment,
        project: i.project,
        provider: i.provider,
        status: i.status,
        gitPath: i.gitPath,
      })),
  });
});

router.get('/ml/recommendations', empty);
router.get('/ml/cost-optimization', (_req, res) => {
  res.json({
    currentMonthlyCost: 0,
    projectedMonthlyCost: 0,
    potentialSavings: 0,
    recommendations: [],
  });
});

export default router;
