import type {
  HealthStatus,
  Infrastructure,
  ResourceStatus,
} from '../types/api';
import { getInfrastructure, listDeployments, listInfrastructures } from '../store/memoryStore';

/** Map infrastructure resource status to health. */
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
  source: 'inventory';
}

function healthMessage(infra: Infrastructure, health: HealthStatus): string {
  switch (health) {
    case 'healthy':
      return 'Status: running.';
    case 'warning':
      if (infra.status === 'stale') return 'Status: stale.';
      if (infra.status === 'pending') return 'Status: pending.';
      return 'Status: degraded.';
    case 'critical':
      return 'Status: error.';
    default:
      if (infra.status === 'destroyed') return 'Status: destroyed.';
      return 'Status: unknown.';
  }
}

export async function getInfraHealth(infraId: string): Promise<InfraHealth | null> {
  const infra = await getInfrastructure(infraId);
  if (!infra) return null;
  const status = healthFromResourceStatus(infra.status);
  return {
    infrastructureId: infra.id,
    name: infra.name,
    environment: infra.environment,
    provider: infra.provider,
    project: infra.project,
    resourceStatus: infra.status,
    status,
    updatedAt: infra.updatedAt,
    message: healthMessage(infra, status),
    source: 'inventory',
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

/** Alerts derived from infrastructure inventory status. */
export async function listInventoryAlerts(): Promise<MonitoringAlert[]> {
  const items = await listInfrastructures();
  const alerts: MonitoringAlert[] = [];

  for (const infra of items) {
    if (infra.status === 'destroyed') continue;
    const health = healthFromResourceStatus(infra.status);
    if (health === 'healthy' || health === 'unknown') continue;

    alerts.push({
      id: `inv-${infra.id}-${infra.status}`,
      ruleName:
        infra.status === 'error'
          ? 'infrastructure-error'
          : infra.status === 'stale'
            ? 'infrastructure-stale'
            : 'infrastructure-warning',
      resource: infra.name,
      resourceId: infra.id,
      severity: health === 'critical' ? 'critical' : 'warning',
      status: 'firing',
      message: healthMessage(infra, health),
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

/** Status gauge for UI: 0 unknown, 1 critical, 2 warning, 3 healthy. */
function statusGauge(status: ResourceStatus): number {
  switch (status) {
    case 'running':
      return 3;
    case 'degraded':
    case 'pending':
    case 'stale':
      return 2;
    case 'error':
      return 1;
    default:
      return 0;
  }
}

export async function getInfraMetrics(infraId: string): Promise<MetricSeries[] | null> {
  const infra = await getInfrastructure(infraId);
  if (!infra) return null;

  const now = new Date().toISOString();
  const updatedAgeSec = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(infra.updatedAt)) / 1000)
  );

  const deployments = (await listDeployments()).filter((d) => d.infrastructureId === infraId);
  const last = deployments.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  const series: MetricSeries[] = [
    {
      metric: 'grid_infra_health_gauge',
      labels: {
        infrastructure_id: infra.id,
        name: infra.name,
        resource_status: infra.status,
        health: healthFromResourceStatus(infra.status),
      },
      data: [{ timestamp: now, value: statusGauge(infra.status) }],
    },
    {
      metric: 'grid_infra_updated_age_seconds',
      labels: { infrastructure_id: infra.id, name: infra.name },
      data: [{ timestamp: now, value: updatedAgeSec }],
    },
  ];

  if (last) {
    series.push({
      metric: 'grid_last_deployment_progress',
      labels: {
        infrastructure_id: infra.id,
        deployment_id: last.id,
        deployment_status: last.status,
        mode: last.mode || 'apply',
      },
      data: [{ timestamp: last.completedAt || last.startedAt, value: last.progress ?? 0 }],
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
}

export async function listMonitoringDashboards(): Promise<MonitoringDashboard[]> {
  const items = await listInfrastructures();
  return items
    .filter((i) => i.status !== 'destroyed')
    .map((infra) => ({
      id: infra.id,
      name: infra.name,
      environment: infra.environment,
      provider: infra.provider,
      resourceStatus: infra.status,
      health: healthFromResourceStatus(infra.status),
      updatedAt: infra.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
