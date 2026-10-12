import type {
  HealthStatus,
  Infrastructure,
  ResourceStatus,
} from '../types/api';
import {
  getInfrastructure,
  listDeployments,
  listInfrastructures,
} from '../store/memoryStore';
import {
  fetchUnitUpById,
  isPrometheusConfigured,
  promQueryRange,
} from './prometheus/prometheusClient';
import { inferCollectorProfile } from './monitoring/collectorConfigService';
import { resolveResourceType } from './resourceType';

export type HealthSource = 'prometheus' | 'inventory';

/**
 * host / kubernetes collectors emit `up{grid_unit_id=…}` from the workload.
 * labels-only covers managed / network / storage / … kinds: no agent on the
 * resource itself. Until a metrics bridge stamps `grid_unit_id`, health for
 * that structural bucket stays inventory — cloud-agnostic, not a product list.
 */
function expectsWorkloadCollectorSeries(infra: Infrastructure): boolean {
  const resourceType = resolveResourceType({
    configJson: infra.configJson,
    gitPath: infra.gitPath,
    name: infra.name,
  });
  const profile = inferCollectorProfile(resourceType);
  return profile === 'host' || profile === 'kubernetes';
}

/** Map control-plane resource status to health when metrics are unavailable. */
export function healthFromResourceStatus(status: ResourceStatus): HealthStatus {
  switch (status) {
    case 'running':
      return 'healthy';
    case 'degraded':
    case 'pending':
    case 'stale':
      return 'warning';
    case 'error':
      return 'critical';
    case 'stopped':
    case 'destroyed':
    default:
      return 'unknown';
  }
}

/** Map scrape `up` sample to health. */
export function healthFromUpValue(up: number): HealthStatus {
  if (up >= 1) return 'healthy';
  if (up === 0) return 'critical';
  return 'warning';
}

export interface InfraHealth {
  infrastructureId: string;
  name: string;
  environment: string;
  provider: string;
  project?: string;
  resourceStatus: ResourceStatus;
  status: HealthStatus;
  updatedAt: string;
  message: string;
  source: HealthSource;
}

function inventoryMessage(infra: Infrastructure, health: HealthStatus): string {
  switch (health) {
    case 'healthy':
      return 'Status: running (inventory).';
    case 'warning':
      if (infra.status === 'stale') return 'Status: stale (inventory).';
      if (infra.status === 'pending') return 'Status: pending (inventory).';
      return 'Status: degraded (inventory).';
    case 'critical':
      return 'Status: error (inventory).';
    default:
      if (infra.status === 'destroyed') return 'Status: destroyed (inventory).';
      return 'Status: unknown (inventory).';
  }
}

function prometheusMessage(health: HealthStatus): string {
  switch (health) {
    case 'healthy':
      return 'Metrics: target up for this unit.';
    case 'critical':
      return 'Metrics: target down (up=0).';
    case 'warning':
      return 'Metrics: degraded signal.';
    default:
      return 'Metrics: no series for this unit yet.';
  }
}

export function resolveUnitHealth(
  infra: Infrastructure,
  upByUnitId: Map<string, number> | null
): { status: HealthStatus; source: HealthSource; message: string } {
  if (!upByUnitId) {
    const status = healthFromResourceStatus(infra.status);
    return {
      status,
      source: 'inventory',
      message: inventoryMessage(infra, status),
    };
  }

  const up = upByUnitId.get(infra.id);
  if (up !== undefined) {
    const status = healthFromUpValue(up);
    return {
      status,
      source: 'prometheus',
      message: prometheusMessage(status),
    };
  }

  // Prom is configured but this unit has no join series yet.
  if (expectsWorkloadCollectorSeries(infra)) {
    return {
      status: 'unknown',
      source: 'prometheus',
      message: prometheusMessage('unknown'),
    };
  }

  // labels-only structural bucket: lifecycle status until a bridge exists.
  const status = healthFromResourceStatus(infra.status);
  return {
    status,
    source: 'inventory',
    message: `${inventoryMessage(infra, status)} No metrics series for this unit kind yet (labels-only).`,
  };
}

async function loadUpMap(): Promise<Map<string, number> | null> {
  if (!isPrometheusConfigured()) return null;
  try {
    return await fetchUnitUpById();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[monitoring] metrics query failed — using inventory status: ${msg}`);
    return null;
  }
}

export async function getInfraHealth(infraId: string): Promise<InfraHealth | null> {
  const infra = await getInfrastructure(infraId);
  if (!infra) return null;
  const upByUnitId = await loadUpMap();
  const resolved = resolveUnitHealth(infra, upByUnitId);
  return {
    infrastructureId: infra.id,
    name: infra.name,
    environment: infra.environment,
    provider: infra.provider,
    project: infra.project,
    resourceStatus: infra.status,
    status: resolved.status,
    updatedAt: infra.updatedAt,
    message: resolved.message,
    source: resolved.source,
  };
}

export interface MonitoringAlert {
  id: string;
  ruleName: string;
  resource: string;
  resourceId: string;
  severity: 'critical' | 'warning' | 'info';
  status: 'firing' | 'acknowledged' | 'resolved';
  message: string;
  startedAt: string;
}

/** Alerts from metrics health when configured; otherwise inventory status. */
export async function listInventoryAlerts(): Promise<MonitoringAlert[]> {
  const items = await listInfrastructures();
  const upByUnitId = await loadUpMap();
  const alerts: MonitoringAlert[] = [];

  for (const infra of items) {
    if (infra.status === 'destroyed') continue;
    const resolved = resolveUnitHealth(infra, upByUnitId);
    if (resolved.status === 'healthy' || resolved.status === 'unknown') continue;

    alerts.push({
      id: `mon-${infra.id}-${resolved.source}-${resolved.status}`,
      ruleName:
        resolved.status === 'critical'
          ? 'infrastructure-critical'
          : 'infrastructure-warning',
      resource: infra.name,
      resourceId: infra.id,
      severity: resolved.status === 'critical' ? 'critical' : 'warning',
      status: 'firing',
      message: resolved.message,
      startedAt: infra.updatedAt,
    });
  }

  return alerts.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface MetricPoint {
  timestamp: string;
  value: number;
}

export interface MetricSeries {
  metric: string;
  labels: Record<string, string>;
  data: MetricPoint[];
}

/** Numeric health gauge for UI: 0 unknown, 1 critical, 2 warning, 3 healthy. */
function statusGauge(health: HealthStatus): number {
  switch (health) {
    case 'healthy':
      return 3;
    case 'warning':
      return 2;
    case 'critical':
      return 1;
    default:
      return 0;
  }
}

function rangeToWindow(range: string): { start: number; end: number; step: string } {
  const end = Math.floor(Date.now() / 1000);
  const spans: Record<string, number> = {
    '1h': 3600,
    '6h': 6 * 3600,
    '24h': 24 * 3600,
    '7d': 7 * 24 * 3600,
  };
  const span = spans[range] ?? spans['1h'];
  const step =
    span <= 3600 ? '60' : span <= 6 * 3600 ? '300' : span <= 24 * 3600 ? '900' : '3600';
  return { start: end - span, end, step };
}

async function prometheusMetricsForUnit(
  infra: Infrastructure,
  range: string
): Promise<MetricSeries[]> {
  const { start, end, step } = rangeToWindow(range);
  const id = infra.id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const query = `up{grid_unit_id="${id}"}`;
  const samples = await promQueryRange({ query, start, end, step });
  return samples.map((s) => ({
    metric: 'up',
    labels: { ...s.metric, grid_unit_id: infra.id },
    data: (s.values || []).map(([ts, v]) => ({
      timestamp: new Date(ts * 1000).toISOString(),
      value: Number(v),
    })),
  }));
}

function inventoryMetricsForUnit(infra: Infrastructure, health: HealthStatus): MetricSeries[] {
  const now = new Date().toISOString();
  const updatedAgeSec = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(infra.updatedAt)) / 1000)
  );

  return [
    {
      metric: 'grid_infra_health_gauge',
      labels: {
        infrastructure_id: infra.id,
        name: infra.name,
        resource_status: infra.status,
        health,
        source: 'inventory',
      },
      data: [{ timestamp: now, value: statusGauge(health) }],
    },
    {
      metric: 'grid_infra_updated_age_seconds',
      labels: { infrastructure_id: infra.id, name: infra.name },
      data: [{ timestamp: now, value: updatedAgeSec }],
    },
  ];
}

export async function getInfraMetrics(
  infraId: string,
  range = '1h'
): Promise<MetricSeries[] | null> {
  const infra = await getInfrastructure(infraId);
  if (!infra) return null;

  const upByUnitId = await loadUpMap();
  const resolved = resolveUnitHealth(infra, upByUnitId);

  if (isPrometheusConfigured() && resolved.source === 'prometheus') {
    try {
      const series = await prometheusMetricsForUnit(infra, range);
      if (series.length > 0) return series;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[monitoring] metrics range query failed: ${msg}`);
    }
  }

  const series = inventoryMetricsForUnit(infra, resolved.status);
  const deployments = (await listDeployments()).filter((d) => d.infrastructureId === infraId);
  const last = deployments.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (last) {
    series.push({
      metric: 'grid_last_deployment_progress',
      labels: {
        infrastructure_id: infra.id,
        deployment_id: last.id,
        deployment_status: last.status,
        mode: last.mode || 'apply',
      },
      data: [
        {
          timestamp: last.completedAt || last.startedAt,
          value: last.progress ?? 0,
        },
      ],
    });
  }
  return series;
}

export interface MonitoringDashboard {
  id: string;
  name: string;
  environment: string;
  provider: string;
  resourceStatus: ResourceStatus;
  health: HealthStatus;
  updatedAt: string;
  source: HealthSource;
}

export async function listMonitoringDashboards(): Promise<MonitoringDashboard[]> {
  const items = await listInfrastructures();
  const upByUnitId = await loadUpMap();

  return items
    .filter((i) => i.status !== 'destroyed')
    .map((infra) => {
      const resolved = resolveUnitHealth(infra, upByUnitId);
      return {
        id: infra.id,
        name: infra.name,
        environment: infra.environment,
        provider: infra.provider,
        resourceStatus: infra.status,
        health: resolved.status,
        updatedAt: infra.updatedAt,
        source: resolved.source,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
