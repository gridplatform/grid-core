import type { Infrastructure, TopologyProvider } from '../types/api';
import { healthFromResourceStatus } from './monitoringService';
import { resolveResourceType } from './resourceType';

export type TopologyLayer =
  | 'waf'
  | 'network'
  | 'loadbalancer'
  | 'application'
  | 'data';

/**
 * Ring a catalog type sits on. The type string is the configuration —
 * not a rewrite into one cloud's resource names.
 */
export function layerForResourceType(type: string | undefined): TopologyLayer {
  const t = (type || '').trim().toLowerCase();
  if (!t) return 'application';
  if (/waf|shield|cloud-armor|guardduty|security-hub|inspector/.test(t)) {
    return 'waf';
  }
  if (
    /^(alb|nlb|clb|gclb|elb|slb)$|load-balancer|loadbalancer|api-gateway|apigateway/.test(
      t
    )
  ) {
    return 'loadbalancer';
  }
  if (
    /vpc|subnet|vnet|vswitch|nat-gateway|vpn|dns|route53|gateway|peering|transit|nsg|security-group|eip|cdn|cloudfront|firewall/.test(
      t
    )
  ) {
    return 'network';
  }
  if (
    /rds|sql|dynamo|redis|mongo|postgres|mysql|bucket|s3|gcs|storage|disk|volume|bigquery|warehouse|elasticache|memorystore|spanner|firestore|bigtable|cache/.test(
      t
    )
  ) {
    return 'data';
  }
  return 'application';
}

/** Build a console-compatible topology view from stored infrastructures. */
export function buildTopologyFromInfrastructures(
  items: Infrastructure[]
): TopologyProvider[] {
  const byProvider = new Map<string, Infrastructure[]>();

  for (const item of items) {
    const key = item.provider;
    const list = byProvider.get(key) || [];
    list.push(item);
    byProvider.set(key, list);
  }

  const providers: TopologyProvider[] = [];

  for (const [providerType, list] of byProvider.entries()) {
    const providerId = `provider-${providerType.toLowerCase()}`;
    const vpcs = list.map((infra) => {
      const cfg = infra.configJson as {
        region?: string;
        resources?: Array<{ type: string; name: string; cidr?: string }>;
      };
      const resourceType = resolveResourceType({
        configJson: infra.configJson,
        gitPath: infra.gitPath,
        name: infra.name,
      });
      const region = cfg.region || '';
      const typedResources =
        cfg.resources && cfg.resources.length > 0
          ? cfg.resources
          : [{ type: resourceType, name: infra.name }];
      const resources = typedResources.map((r) => ({
        id: `${infra.id}-${r.name}`,
        name: r.name,
        type: r.type,
        layer: layerForResourceType(r.type),
        status: healthFromResourceStatus(infra.status),
        connections: [] as string[],
        meta: r.cidr ? { cidr: r.cidr } : undefined,
      }));
      const network = typedResources.find((r) => r.cidr);

      return {
        id: `vpc-${infra.id}`,
        name: infra.name,
        resourceType,
        region,
        cidr: network?.cidr || '',
        providerId,
        resources,
        vpcConnections: [] as [],
        totalResources: resources.length,
        healthCounts: {
          healthy: resources.filter((r) => r.status === 'healthy').length,
          warning: resources.filter((r) => r.status === 'warning').length,
          critical: resources.filter((r) => r.status === 'critical').length,
        },
        status: healthFromResourceStatus(infra.status),
      };
    });

    const allResources = vpcs.flatMap((v) => v.resources);
    providers.push({
      id: providerId,
      name: providerType,
      type: providerType as TopologyProvider['type'],
      vpcs,
      totalResources: allResources.length,
      healthCounts: {
        healthy: allResources.filter((r) => r.status === 'healthy').length,
        warning: allResources.filter((r) => r.status === 'warning').length,
        critical: allResources.filter((r) => r.status === 'critical').length,
      },
    });
  }

  return providers;
}
