import { Router } from 'express';
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
import { enqueueRelease } from '../services/releaseService';
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
  const cfg = infra.configJson as { region?: string; provider?: string };
  return {
    id: infra.id,
    name: infra.name,
    type: 'single-vm',
    status: infra.status,
    region: cfg.region || 'ap-south-1',
    environment: infra.environment,
    provider: infra.provider,
    project: infra.project,
    connections: [],
    config: infra.configJson,
  };
}

async function startLifecycle(
  infra: Infrastructure,
  mode: LifecycleMode,
  meta?: { name?: string; engine?: string; resourceType?: string; provider?: string; environment?: string }
) {
  await cancelActiveDeploymentsForInfrastructure(infra.id);
  const deployment = await createDeployment(infra.id, config.demoUser.email, {
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

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'grid-core' });
});

router.get('/auth/me', (_req, res) => {
  res.json(config.demoUser);
});

router.post('/auth/login', (_req, res) => {
  res.json({
    token: 'demo-token',
    user: config.demoUser,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
});

router.post('/auth/register', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Register not enabled in demo' });
});

router.post('/auth/refresh', (_req, res) => {
  res.json({ token: 'demo-token', expiresAt: new Date(Date.now() + 86400000).toISOString() });
});

router.post('/auth/logout', (_req, res) => {
  res.status(204).end();
});

router.get('/infrastructures', async (_req, res) => {
  const existing = await listInfrastructures();
  if (existing.length === 0) {
    // First load — must populate from desired-state tree.
    await syncInfrastructuresFromConfigRoot({ force: true });
  } else {
    // Refresh in background when TTL allows; do not block the UI.
    void syncInfrastructuresFromConfigRoot();
  }
  const items = await listInfrastructures();
  // Config-backed units + stale (removed from config, still in state). Never list destroyed orphans.
  res.json(
    items
      .filter((i) => i.status !== 'destroyed')
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

  const shouldApply = req.query.apply === 'true' || req.query.apply === '1';
  const shouldPlan = req.query.plan === 'true' || req.query.plan === '1';

  if (shouldApply || shouldPlan) {
    const deployment = await startLifecycle(infra, shouldApply ? 'apply' : 'plan');
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
  res.json(infra);
});

router.post('/infrastructures/:id/plan', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  if (infra.status === 'destroyed') {
    res.status(409).json({ code: 'destroyed', message: 'Infrastructure was destroyed' });
    return;
  }
  const deployment = await startLifecycle(infra, 'plan');
  res.status(202).json(deployment);
});

router.post('/infrastructures/:id/apply', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  if (infra.status === 'destroyed') {
    res.status(409).json({ code: 'destroyed', message: 'Infrastructure was destroyed' });
    return;
  }
  const deployment = await startLifecycle(infra, 'apply');
  res.status(202).json(deployment);
});

router.post('/infrastructures/:id/destroy', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  if (infra.status === 'destroyed') {
    res.status(409).json({ code: 'destroyed', message: 'Already destroyed' });
    return;
  }
  const deployment = await startLifecycle(infra, 'destroy');
  res.status(202).json(deployment);
});

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
    res.json(restored);
  } catch (err) {
    res.status(500).json({
      code: 'restore_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Legacy alias for apply */
router.post('/infrastructures/:id/deploy', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  const deployment = await startLifecycle(infra, 'apply');
  res.status(202).json(deployment);
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

/** DELETE runs terraform destroy */
router.delete('/infrastructures/:id', async (req, res) => {
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  if (infra.status === 'destroyed') {
    res.status(204).end();
    return;
  }
  const deployment = await startLifecycle(infra, 'destroy');
  res.status(202).json(deployment);
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
  const deployment = await startLifecycle(infra, mode, {
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
  const next = await startLifecycle(infra, mode, {
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
  mode: z.enum(['plan', 'apply', 'custom']),
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
  try {
    const release = await enqueueRelease({
      ...parsed.data,
      createdBy: config.demoUser.email,
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

router.get('/approvals', empty);
router.post('/approvals/:id/approve', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Approvals not enabled' });
});
router.post('/approvals/:id/reject', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Approvals not enabled' });
});

router.get('/clusters', empty);
router.post('/clusters/:id/scale', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Clusters not enabled' });
});

router.get('/monitoring/alerts', empty);
router.get('/monitoring/metrics/:infra', (_req, res) => res.json([]));
router.post('/monitoring/alerts', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Monitoring not enabled' });
});
router.post('/monitoring/setup/:infra', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Monitoring not enabled' });
});
router.get('/monitoring/dashboards', empty);
router.get('/monitoring/health/:infra', (_req, res) => {
  res.json({ status: 'unknown' });
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
