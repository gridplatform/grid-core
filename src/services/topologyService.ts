import type {
  HealthStatus,
  Infrastructure,
  TopologyEnvConnection,
  TopologyProvider,
  TopologyResource,
  TopologyEnvironment,
} from '../types/api';
import { healthFromResourceStatus } from './monitoringService';
import { resolveResourceType } from './resourceType';

export type TopologyLayer =
  | 'waf'
  | 'network'
  | 'loadbalancer'
  | 'application'
  | 'data'
  | 'ai-ml'
  | 'observability';

/**
 * Whole catalog type names only. A substring such as "pai" or "ops"
 * must not pull keypair or devops onto these rings.
 */
const AI_ML_TYPES = new Set([
  'ai-foundry',
  'ai-language',
  'ai-search',
  'anomaly-detection',
  'azure-ml',
  'azure-openai',
  'bedrock-agent',
  'bedrock-agentcore',
  'bedrock-guardrail',
  'bedrock-knowledge-base',
  'bedrock-prompt',
  'bentoml',
  'braket',
  'chroma',
  'cognitive-services',
  'comprehend',
  'content-safety',
  'data-science',
  'deepspeed',
  'dialogflow',
  'dialogflow-cx',
  'digital-assistant',
  'document-ai',
  'document-understanding',
  'eas',
  'forecast',
  'fraud-detector',
  'gemini-api',
  'generative-ai',
  'generative-ai-agent',
  'healthcare-api',
  'healthcare-apis',
  'healthlake',
  'hilens',
  'huggingface-tgi',
  'kendra',
  'kserve',
  'kuberay',
  'language',
  'lex',
  'life-sciences',
  'litellm-gateway',
  'llm-inference-endpoint',
  'lookout-equipment',
  'lookout-metrics',
  'lookout-vision',
  'milvus',
  'mlflow',
  'modelarts',
  'natural-language',
  'nlp',
  'nova',
  'nvidia-nim',
  'ollama',
  'open-webui',
  'pai',
  'personalize',
  'pgvector',
  'polly',
  'q-business',
  'qdrant',
  'ray-cluster',
  'rekognition',
  'sagemaker',
  'sagemaker-domain',
  'sagemaker-feature-store',
  'sglang',
  'speech',
  'speech-to-text',
  'tensorrt-llm',
  'textract',
  'text-to-speech',
  'tiems',
  'tiia',
  'tpu',
  'transcribe',
  'translate',
  'translation',
  'translator',
  'triton-inference-server',
  'vertex-ai',
  'vertex-ai-workbench',
  'video-ai',
  'vision',
  'vision-ai',
  'vllm',
  'watson-assistant',
  'watson-discovery',
  'watsonx',
  'weaviate',
]);

const OBSERVABILITY_TYPES = new Set([
  'aom',
  'apm',
  'application-insights',
  'arms',
  'ces',
  'ces-monitoring',
  'cloud-logging',
  'cloud-trace',
  'cloudwatch',
  'cls',
  'cluster-monitoring',
  'cms',
  'error-reporting',
  'log',
  'log-analytics',
  'log-export',
  'logging',
  'logs',
  'lts',
  'managed-grafana',
  'managed-prometheus',
  'metrics',
  'monitor',
  'monitoring',
  'monitoring-alert',
  'ops-insights',
  'stack-monitoring',
  'sysdig',
  'xray',
]);

/**
 * Ring a catalog type sits on. The type string is the configuration —
 * not a rewrite into one cloud's resource names.
 */
export function layerForResourceType(type: string | undefined): TopologyLayer {
  const t = (type || '').trim().toLowerCase();
  if (!t) return 'application';
  if (AI_ML_TYPES.has(t)) return 'ai-ml';
  if (OBSERVABILITY_TYPES.has(t)) return 'observability';
  if (
    /waf|shield|cloud-armor|guardduty|security-hub|inspector|cloud-guard|firewall-manager|security-center/.test(
      t
    )
  ) {
    return 'waf';
  }
  if (
    /^(alb|nlb|clb|gclb|elb|slb)$|^lb-|load-balancer|loadbalancer|api-gateway|apigateway|application-gateway|front-door/.test(
      t
    )
  ) {
    return 'loadbalancer';
  }
  if (
    /vpc|subnet|vnet|vswitch|vpn|dns|route53|gateway|peering|transit|nsg|security-group|security-list|eip|cdn|cloudfront|firewall|express-connect|privatelink|private-endpoint|(^|-)nat($|-)|(^|-)network($|-)|(^|-)router($|-)|(^|-)cen($|-)|(^|-)ccn($|-)|(^|-)acl($|-)|ip-address/.test(
      t
    )
  ) {
    return 'network';
  }
  if (
    /rds|sql|dynamo|redis|mongo|postgres|mysql|mariadb|cosmos|database|bucket|s3|gcs|storage|disk|volume|bigquery|warehouse|elasticache|memorystore|spanner|firestore|bigtable|cache|filestore|backup|(^|-)oss($|-)|(^|-)obs($|-)|(^|-)nas($|-)/.test(
      t
    )
  ) {
    return 'data';
  }
  return 'application';
}

const ENV_ORDER = ['development', 'staging', 'production'];

function environmentRank(name: string): number {
  const i = ENV_ORDER.indexOf(name.trim().toLowerCase());
  return i === -1 ? ENV_ORDER.length : i;
}

function rollupStatus(resources: TopologyResource[]): HealthStatus {
  if (resources.some((r) => r.status === 'critical')) return 'critical';
  if (resources.some((r) => r.status === 'warning')) return 'warning';
  if (resources.some((r) => r.status === 'healthy')) return 'healthy';
  return 'unknown';
}

function circleId(provider: string, environment: string): string {
  return `env-provider-${provider.trim().toLowerCase()}-${environment.trim().toLowerCase()}`;
}

/** `provider/environment/type/unit.json` — project-relative dependsOn. */
function dependsOnTarget(path: string): { provider: string; environment: string } | null {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { provider: parts[0], environment: parts[1] };
}

function isPeeringType(type: string): boolean {
  return /peering/.test(type.trim().toLowerCase());
}

/**
 * A peering unit connects its environment to each different environment named in dependsOn.
 */
function peeringConnections(
  items: Infrastructure[],
  circleIds: Set<string>
): Map<string, TopologyEnvConnection[]> {
  const bySource = new Map<string, TopologyEnvConnection[]>();
  const seen = new Set<string>();

  for (const infra of items) {
    const type = resolveResourceType({
      configJson: infra.configJson,
      gitPath: infra.gitPath,
      name: infra.name,
    });
    if (!isPeeringType(type)) continue;

    const sourceEnv = infra.environment?.trim() || 'default';
    const sourceId = circleId(infra.provider, sourceEnv);
    const dependsOn = (infra.configJson as { metadata?: { dependsOn?: unknown } }).metadata
      ?.dependsOn;
    if (!Array.isArray(dependsOn)) continue;

    for (const entry of dependsOn) {
      if (typeof entry !== 'string') continue;
      const target = dependsOnTarget(entry);
      if (!target) continue;
      if (target.environment.trim().toLowerCase() === sourceEnv.toLowerCase()) continue;
      const targetId = circleId(target.provider, target.environment);
      if (!circleIds.has(sourceId) || !circleIds.has(targetId) || sourceId === targetId) {
        continue;
      }
      const key = [sourceId, targetId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const list = bySource.get(sourceId) || [];
      list.push({ targetId, type: 'peering', label: 'peering' });
      bySource.set(sourceId, list);
    }
  }

  return bySource;
}

function resourcesForUnit(infra: Infrastructure): TopologyResource[] {
  const cfg = infra.configJson as {
    resources?: Array<{ type: string; name: string; cidr?: string }>;
  };
  const resourceType = resolveResourceType({
    configJson: infra.configJson,
    gitPath: infra.gitPath,
    name: infra.name,
  });
  const typed =
    cfg.resources && cfg.resources.length > 0
      ? cfg.resources
      : [{ type: resourceType, name: infra.name }];
  return typed.map((r) => ({
    id: `${infra.id}-${r.name}`,
    name: r.name,
    type: r.type,
    layer: layerForResourceType(r.type),
    status: healthFromResourceStatus(infra.status),
    connections: [] as string[],
    meta: r.cidr ? { cidr: r.cidr } : undefined,
  }));
}

/**
 * One circle per environment inside each cloud.
 * Environment is not a filter: every environment of the given units is a circle.
 */
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

  const circles: TopologyEnvironment[] = [];
  const providers: TopologyProvider[] = [];

  for (const [providerType, list] of byProvider.entries()) {
    const providerId = `provider-${providerType.toLowerCase()}`;
    const byEnv = new Map<string, Infrastructure[]>();
    for (const infra of list) {
      const env = infra.environment?.trim() || 'default';
      const group = byEnv.get(env) || [];
      group.push(infra);
      byEnv.set(env, group);
    }

    const environments = [...byEnv.entries()]
      .sort(([a], [b]) => environmentRank(a) - environmentRank(b) || a.localeCompare(b))
      .map(([env, units]) => {
        const resources = units.flatMap(resourcesForUnit);
        const circle: TopologyEnvironment = {
          id: circleId(providerType, env),
          name: env,
          region: '',
          cidr: '',
          providerId,
          resources,
          connections: [],
          totalResources: resources.length,
          healthCounts: {
            healthy: resources.filter((r) => r.status === 'healthy').length,
            warning: resources.filter((r) => r.status === 'warning').length,
            critical: resources.filter((r) => r.status === 'critical').length,
          },
          status: rollupStatus(resources),
        };
        circles.push(circle);
        return circle;
      });

    const allResources = environments.flatMap((v) => v.resources);
    providers.push({
      id: providerId,
      name: providerType,
      type: providerType as TopologyProvider['type'],
      environments,
      totalResources: allResources.length,
      healthCounts: {
        healthy: allResources.filter((r) => r.status === 'healthy').length,
        warning: allResources.filter((r) => r.status === 'warning').length,
        critical: allResources.filter((r) => r.status === 'critical').length,
      },
    });
  }

  const links = peeringConnections(items, new Set(circles.map((c) => c.id)));
  for (const circle of circles) {
    circle.connections = links.get(circle.id) || [];
  }

  return providers;
}
