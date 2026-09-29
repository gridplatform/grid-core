import type { Infrastructure, TopologyProvider } from '../types/api';

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
      const vpcResource = cfg.resources?.find((r) => r.type === 'vpc');
      const region = cfg.region || 'ap-south-1';
      const resources = (cfg.resources || []).map((r) => ({
        id: `${infra.id}-${r.name}`,
        name: r.name,
        type:
          r.type === 'vm'
            ? providerType === 'AWS'
              ? 'ec2-instance'
              : 'gce-instance'
            : r.type === 'vpc'
              ? 'internet-gateway'
              : r.type === 'subnet'
                ? 'nat-gateway'
                : r.type,
        layer:
          r.type === 'vm' ? 'application' : r.type === 'vpc' || r.type === 'subnet' ? 'network' : 'application',
        status: (infra.status === 'running' ? 'healthy' : infra.status === 'error' ? 'critical' : 'unknown') as
          | 'healthy'
          | 'warning'
          | 'critical'
          | 'unknown',
        connections: [] as string[],
        meta: r.cidr ? { cidr: r.cidr } : undefined,
      }));

      return {
        id: `vpc-${infra.id}`,
        name: vpcResource?.name || infra.name,
        region,
        cidr: vpcResource?.cidr || '0.0.0.0/0',
        providerId,
        resources,
        vpcConnections: [] as [],
        totalResources: resources.length,
        healthCounts: {
          healthy: resources.filter((r) => r.status === 'healthy').length,
          warning: resources.filter((r) => r.status === 'warning').length,
          critical: resources.filter((r) => r.status === 'critical').length,
        },
        status: (infra.status === 'running'
          ? 'healthy'
          : infra.status === 'error'
            ? 'critical'
            : 'unknown') as 'healthy' | 'warning' | 'critical' | 'unknown',
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
