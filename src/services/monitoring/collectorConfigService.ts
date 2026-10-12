/**
 * Generate collector (Grafana Alloy) config for an infrastructure unit.
 *
 * Profiles:
 * - host — Unix node exporter scrape (VMs / bare metal / any provider)
 * - kubernetes — in-cluster discovery scrape (managed or self-hosted clusters)
 * - labels-only — remote_write + identity stamps (attach your own scrapes)
 *
 * Grid does not install agents; it emits GitOps-friendly Alloy config that
 * stamps `grid_unit_id` so Monitoring can join series to inventory.
 */

import path from 'path';
import fs from 'fs-extra';
import { config } from '../../config';
import type { Infrastructure } from '../../types/api';
import { getInfrastructure } from '../../store/memoryStore';
import { resolveResourceType } from '../resourceType';
import { alloyRelabelRules, buildUnitMetricLabels, type UnitMetricLabels } from './collectorLabels';

export type CollectorProfile = 'host' | 'kubernetes' | 'labels-only';

export interface CollectorConfigResult {
  infrastructureId: string;
  name: string;
  profile: CollectorProfile;
  labels: UnitMetricLabels;
  /** Alloy River config */
  alloy: string;
  /** Relative path under GRID_CONFIG_ROOT when written by setup */
  gitPath: string;
  instructions: string[];
}

/** Structural profile from unit kind — not a product catalog. */
export function inferCollectorProfile(resourceType: string): CollectorProfile {
  const t = resourceType.trim().toLowerCase();
  if (!t) return 'labels-only';
  if (
    /kubernetes|k8s|node-pool|node-group|karpenter|machine-pool|openshift|rosa|roks/.test(
      t
    ) ||
    /^(eks|gke|aks|oke|ack|tke|cce|roks|rosa)(-|$)/.test(t)
  ) {
    return 'kubernetes';
  }
  if (
    /^(vm|ec2|instance|host|bare-metal|gpu-instance|single-vm)/.test(t) ||
    /virtual-machine|compute-engine|lightsail/.test(t)
  ) {
    return 'host';
  }
  return 'labels-only';
}

function remoteWriteBlock(): string {
  return `prometheus.remote_write "grid" {
  endpoint {
    // Set GRID_PROM_REMOTE_WRITE_URL (e.g. http://prometheus:9090/api/v1/write)
    url = coalesce(sys.env("GRID_PROM_REMOTE_WRITE_URL"), "http://127.0.0.1:9090/api/v1/write")
  }
}`;
}

function hostAlloy(labels: UnitMetricLabels): string {
  const rules = alloyRelabelRules(labels);
  return `// Grid host collector — node metrics for one infrastructure unit.
// Provider-agnostic: run on the instance (any cloud / region).

prometheus.exporter.unix "node" { }

prometheus.scrape "node" {
  targets    = prometheus.exporter.unix.node.targets
  forward_to = [prometheus.relabel.grid.receiver]
}

prometheus.relabel "grid" {
  forward_to = [prometheus.remote_write.grid.receiver]
${rules}
}

${remoteWriteBlock()}
`;
}

function kubernetesAlloy(labels: UnitMetricLabels): string {
  const rules = alloyRelabelRules(labels);
  return `// Grid kubernetes collector — cluster discovery for one infrastructure unit.
// Run Alloy in the target cluster (any provider). Requires in-cluster RBAC.

discovery.kubernetes "nodes" {
  role = "node"
}

discovery.kubernetes "pods" {
  role = "pod"
}

prometheus.scrape "nodes" {
  targets    = discovery.kubernetes.nodes.targets
  forward_to = [prometheus.relabel.grid.receiver]
}

prometheus.scrape "pods" {
  targets    = discovery.kubernetes.pods.targets
  forward_to = [prometheus.relabel.grid.receiver]
  clustering {
    enabled = false
  }
}

prometheus.relabel "grid" {
  forward_to = [prometheus.remote_write.grid.receiver]
${rules}
}

${remoteWriteBlock()}
`;
}

function labelsOnlyAlloy(labels: UnitMetricLabels): string {
  const rules = alloyRelabelRules(labels);
  return `// Grid identity stamp — attach your scrapes/exporters to this relabel.
// Use for managed services until a dedicated exporter path exists.

prometheus.relabel "grid" {
  // Example: forward_to from your scrape blocks → prometheus.relabel.grid.receiver
  forward_to = [prometheus.remote_write.grid.receiver]
${rules}
}

${remoteWriteBlock()}
`;
}

function renderAlloy(profile: CollectorProfile, labels: UnitMetricLabels): string {
  switch (profile) {
    case 'host':
      return hostAlloy(labels);
    case 'kubernetes':
      return kubernetesAlloy(labels);
    default:
      return labelsOnlyAlloy(labels);
  }
}

function instructionsFor(profile: CollectorProfile, gitPath: string): string[] {
  const common = [
    `Write path (GitOps): $GRID_CONFIG_ROOT/${gitPath}`,
    'Set GRID_PROM_REMOTE_WRITE_URL to your Prometheus (or Mimir) remote_write endpoint.',
    'Ensure GRID_PROMETHEUS_URL on grid-core points at the same Prometheus query API.',
    'Every series must keep label grid_unit_id (stamped by this config).',
  ];
  if (profile === 'host') {
    return [
      ...common,
      'Install Grafana Alloy on the host and run with this config file.',
      'Works for VMs on any provider (AWS, GCP, Azure, Alibaba, Oracle, …).',
    ];
  }
  if (profile === 'kubernetes') {
    return [
      ...common,
      'Deploy Alloy into the cluster (Helm or Operator) with this config.',
      'Grant discovery RBAC for nodes/pods as required by Alloy.',
    ];
  }
  return [
    ...common,
    'Wire your exporter scrapes into prometheus.relabel.grid before remote_write.',
  ];
}

function unitRelPath(infra: Infrastructure): string {
  if (infra.gitPath) {
    const noExt = infra.gitPath.replace(/\.json$/i, '');
    return path.posix.join('monitoring', noExt, 'collector.alloy');
  }
  const safe = infra.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || infra.id;
  return path.posix.join('monitoring', 'units', safe, 'collector.alloy');
}

export async function buildCollectorConfig(
  infraId: string
): Promise<CollectorConfigResult | null> {
  const infra = await getInfrastructure(infraId);
  if (!infra) return null;

  const resourceType = resolveResourceType({
    configJson: infra.configJson,
    gitPath: infra.gitPath,
    name: infra.name,
  });
  const profile = inferCollectorProfile(resourceType);
  const labels = buildUnitMetricLabels({
    unitId: infra.id,
    name: infra.name,
    project: infra.project,
    environment: infra.environment,
    provider: infra.provider,
    resourceType,
  });
  const gitPath = unitRelPath(infra);
  const alloy = renderAlloy(profile, labels);

  return {
    infrastructureId: infra.id,
    name: infra.name,
    profile,
    labels,
    alloy,
    gitPath,
    instructions: instructionsFor(profile, gitPath),
  };
}

/**
 * Materialize collector config under GRID_CONFIG_ROOT (GitOps exit buffer).
 * Does not install Alloy on the target — only writes desired-state files.
 */
export async function writeCollectorConfig(
  infraId: string
): Promise<CollectorConfigResult | null> {
  const built = await buildCollectorConfig(infraId);
  if (!built) return null;

  const abs = path.join(config.configRoot, built.gitPath);
  await fs.ensureDir(path.dirname(abs));
  await fs.writeFile(abs, built.alloy, 'utf8');

  const metaPath = path.join(path.dirname(abs), 'collector.meta.json');
  await fs.writeJson(
    metaPath,
    {
      infrastructureId: built.infrastructureId,
      name: built.name,
      profile: built.profile,
      labels: built.labels,
      updatedAt: new Date().toISOString(),
    },
    { spaces: 2 }
  );

  return built;
}
