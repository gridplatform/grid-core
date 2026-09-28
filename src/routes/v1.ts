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
  saveDeployment,
  saveInfrastructure,
} from '../store/memoryStore';
import { runInfrastructureDeploy } from '../services/deployService';
import { buildTopologyFromInfrastructures } from '../services/topologyService';
import {
  DeployMapError,
  mapDeployRequestToGridConfig,
} from '../services/gridConfigMapper';
import { isDeployEnabledForAnyProvider, productFlags } from '../config/featureFlags';
import { TERRAFORM_RESOURCE_TYPES } from '../services/terraformResourceCatalog';
import type { CloudProviderType, InfrastructureListItem } from '../types/api';

const router = Router();

function featureOff(res: { status: (c: number) => { json: (b: unknown) => void } }, key: string) {
  res.status(403).json({ code: 'feature_disabled', message: `Feature "${key}" is disabled` });
}

/** Cluster endpoints stay open while any provider can still deploy a cluster. */
function clustersEnabled(): boolean {
  return TERRAFORM_RESOURCE_TYPES['kubernetes-cluster'].some(isDeployEnabledForAnyProvider);
}

const CreateInfraSchema = z.object({
  name: z.string().min(1),
  environment: z.string().default('dev'),
  provider: z.enum(['AWS', 'GCP', 'Azure', 'On-Prem']).default('AWS'),
  configJson: z.record(z.unknown()),
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
    connections: [],
    config: infra.configJson,
  };
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

router.get('/features', (_req, res) => {
  res.json(productFlags);
});

router.get('/infrastructures', async (_req, res) => {
  if (!productFlags.infrastructure) {
    featureOff(res, 'infrastructure');
    return;
  }
  const items = await listInfrastructures();
  res.json(items.map((i) => toListItem(i)).filter(Boolean));
});

router.get('/infrastructures/:id', async (req, res) => {
  if (!productFlags.infrastructure) {
    featureOff(res, 'infrastructure');
    return;
  }
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  res.json(infra);
});

router.post('/infrastructures', async (req, res) => {
  if (!productFlags.infrastructure) {
    featureOff(res, 'infrastructure');
    return;
  }
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
  res.status(201).json(infra);
});

router.post('/infrastructures/:id/deploy', async (req, res) => {
  if (!productFlags.infrastructure || !productFlags.deployments) {
    featureOff(res, !productFlags.infrastructure ? 'infrastructure' : 'deployments');
    return;
  }
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }

  const deployment = await createDeployment(infra.id, config.demoUser.email, {
    name: infra.name,
    engine: 'terraform',
    environment: infra.environment,
    provider: infra.provider,
  });
  res.status(202).json(deployment);
  void runInfrastructureDeploy(infra, deployment);
});

router.post('/infrastructures/:id/drift-check', async (req, res) => {
  if (!productFlags.infrastructure) {
    featureOff(res, 'infrastructure');
    return;
  }
  const infra = await getInfrastructure(req.params.id);
  if (!infra) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  res.json({ hasDrift: false, changes: [] });
});

router.post('/infrastructures/:id/clone', async (req, res) => {
  if (!productFlags.infrastructure) {
    featureOff(res, 'infrastructure');
    return;
  }
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

router.delete('/infrastructures/:id', async (req, res) => {
  if (!productFlags.infrastructure) {
    featureOff(res, 'infrastructure');
    return;
  }
  const items = await listInfrastructures();
  const target = items.find((i) => i.id === req.params.id);
  if (!target) {
    res.status(404).json({ code: 'not_found', message: 'Infrastructure not found' });
    return;
  }
  target.status = 'stopped';
  target.updatedAt = new Date().toISOString();
  await saveInfrastructure(target);
  res.status(204).end();
});

router.get('/deployments', async (_req, res) => {
  if (!productFlags.deployments) {
    featureOff(res, 'deployments');
    return;
  }
  res.json(await listDeployments());
});

router.post('/deployments', async (req, res) => {
  if (!productFlags.deployments) {
    featureOff(res, 'deployments');
    return;
  }
  const parsed = CreateDeploymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  let mapped;
  try {
    mapped = mapDeployRequestToGridConfig(parsed.data);
  } catch (err) {
    if (err instanceof DeployMapError) {
      res.status(err.statusCode).json({ code: 'deploy_map_error', message: err.message });
      return;
    }
    throw err;
  }

  const body = parsed.data;
  const infra = await createInfrastructure({
    name: body.name,
    environment: body.environment,
    provider: mapped.displayProvider,
    configJson: mapped.gridConfig,
    status: 'pending',
    autoApprove: true,
    driftDetection: false,
  });

  const deployment = await createDeployment(infra.id, config.demoUser.email, {
    name: body.name,
    engine: body.engine,
    resourceType: body.resourceType,
    provider: body.provider || String(mapped.gridConfig.provider),
    environment: body.environment,
  });

  res.status(202).json(deployment);
  void runInfrastructureDeploy(infra, deployment);
});

router.get('/deployments/:id', async (req, res) => {
  if (!productFlags.deployments) {
    featureOff(res, 'deployments');
    return;
  }
  const d = await getDeployment(req.params.id);
  if (!d) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }
  res.json(d);
});

router.get('/deployments/:id/logs', async (req, res) => {
  if (!productFlags.deployments) {
    featureOff(res, 'deployments');
    return;
  }
  const d = await getDeployment(req.params.id);
  if (!d) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }
  res.json({ deploymentId: d.id, logs: d.logs });
});

router.post('/deployments/:id/cancel', async (req, res) => {
  if (!productFlags.deployments) {
    featureOff(res, 'deployments');
    return;
  }
  const d = await getDeployment(req.params.id);
  if (!d) {
    res.status(404).json({ code: 'not_found', message: 'Deployment not found' });
    return;
  }
  if (d.status === 'running' || d.status === 'pending') {
    d.status = 'cancelled';
    d.completedAt = new Date().toISOString();
    await saveDeployment(d);
  }
  res.status(204).end();
});

router.post('/deployments/:id/retry', async (req, res) => {
  if (!productFlags.deployments) {
    featureOff(res, 'deployments');
    return;
  }
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
  const next = await createDeployment(infra.id, config.demoUser.email, {
    name: d.name || infra.name,
    engine: d.engine || 'terraform',
    resourceType: d.resourceType,
    provider: d.provider,
    environment: d.environment || infra.environment,
  });
  res.status(202).json(next);
  void runInfrastructureDeploy(infra, next);
});

router.get('/topology/providers', async (_req, res) => {
  if (!productFlags.topology) {
    featureOff(res, 'topology');
    return;
  }
  const items = await listInfrastructures();
  res.json(buildTopologyFromInfrastructures(items));
});

router.get('/topology/providers/:id/vpcs', async (req, res) => {
  if (!productFlags.topology) {
    featureOff(res, 'topology');
    return;
  }
  const items = await listInfrastructures();
  const providers = buildTopologyFromInfrastructures(items);
  const provider = providers.find((p) => p.id === req.params.id);
  res.json(provider?.vpcs || []);
});

router.get('/topology/vpcs/:id/resources', async (req, res) => {
  if (!productFlags.topology) {
    featureOff(res, 'topology');
    return;
  }
  const items = await listInfrastructures();
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
  if (!productFlags.topology) {
    featureOff(res, 'topology');
    return;
  }
  res.json([]);
});

const empty = (_req: unknown, res: { json: (b: unknown) => void }) => res.json([]);

router.get('/releases', (req, res) => {
  if (!productFlags.releases) {
    featureOff(res, 'releases');
    return;
  }
  empty(req, res);
});
router.post('/releases/:id/rollback', (_req, res) => {
  if (!productFlags.releases) {
    featureOff(res, 'releases');
    return;
  }
  res.status(501).json({ code: 'not_implemented', message: 'Releases not enabled' });
});

router.get('/approvals', empty);
router.post('/approvals/:id/approve', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Approvals not enabled' });
});
router.post('/approvals/:id/reject', (_req, res) => {
  res.status(501).json({ code: 'not_implemented', message: 'Approvals not enabled' });
});

router.get('/clusters', (req, res) => {
  if (!clustersEnabled()) {
    featureOff(res, 'kubernetes-cluster deploys');
    return;
  }
  empty(req, res);
});
router.post('/clusters/:id/scale', (_req, res) => {
  if (!clustersEnabled()) {
    featureOff(res, 'kubernetes-cluster deploys');
    return;
  }
  res.status(501).json({ code: 'not_implemented', message: 'Clusters not enabled' });
});

router.get('/monitoring/alerts', (req, res) => {
  if (!productFlags.monitoring && !productFlags.alerts) {
    featureOff(res, 'monitoring');
    return;
  }
  empty(req, res);
});
router.get('/monitoring/metrics/:infra', (req, res) => {
  if (!productFlags.monitoring) {
    featureOff(res, 'monitoring');
    return;
  }
  res.json([]);
});
router.post('/monitoring/alerts', (_req, res) => {
  if (!productFlags.alerts) {
    featureOff(res, 'alerts');
    return;
  }
  res.status(501).json({ code: 'not_implemented', message: 'Monitoring not enabled' });
});
router.post('/monitoring/setup/:infra', (_req, res) => {
  if (!productFlags.monitoring) {
    featureOff(res, 'monitoring');
    return;
  }
  res.status(501).json({ code: 'not_implemented', message: 'Monitoring not enabled' });
});
router.get('/monitoring/dashboards', (req, res) => {
  if (!productFlags.monitoring) {
    featureOff(res, 'monitoring');
    return;
  }
  empty(req, res);
});
router.get('/monitoring/health/:infra', (_req, res) => {
  if (!productFlags.monitoring) {
    featureOff(res, 'monitoring');
    return;
  }
  res.json({ status: 'unknown' });
});

router.get('/apm/services', (req, res) => {
  if (!productFlags.apm) {
    featureOff(res, 'apm');
    return;
  }
  empty(req, res);
});
router.get('/apm/services/:id/operations', (req, res) => {
  if (!productFlags.apm) {
    featureOff(res, 'apm');
    return;
  }
  empty(req, res);
});
router.get('/apm/services/:serviceId/operations/:opId/traces', (req, res) => {
  if (!productFlags.apm) {
    featureOff(res, 'apm');
    return;
  }
  empty(req, res);
});
router.get('/apm/traces/:traceId', (_req, res) => {
  if (!productFlags.apm) {
    featureOff(res, 'apm');
    return;
  }
  res.status(404).json({ code: 'not_found', message: 'Trace not found' });
});

router.get('/logs', (req, res) => {
  if (!productFlags.logging) {
    featureOff(res, 'logging');
    return;
  }
  empty(req, res);
});

router.get('/scaling/schedules', empty);
router.get('/scaling/policies', empty);

router.get('/environments', (_req, res) => {
  const now = new Date().toISOString();
  res.json([
    {
      id: 'env-dev',
      name: 'Development',
      slug: 'dev',
      order: 1,
      isProduction: false,
      approvalRequired: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);
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
