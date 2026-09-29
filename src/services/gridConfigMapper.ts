import type { CloudProviderType } from '../types/api';
import { normalizeProviderId } from '../config/providers';
import { COMPUTE_COMPOSER_TYPES, NETWORK_COMPOSER_TYPES } from './terraformResourceCatalog';

export type DeployEngine = 'terraform' | 'kubernetes';

export interface GridDeployRequest {
  name: string;
  engine: DeployEngine;
  provider?: string;
  environment: string;
  resourceType: string;
  config: Record<string, unknown>;
}

export interface MappedDeploy {
  displayProvider: CloudProviderType;
  gridConfig: Record<string, unknown>;
}

export class DeployMapError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 422
  ) {
    super(message);
    this.name = 'DeployMapError';
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toDisplayProvider(providerId: string): CloudProviderType {
  if (providerId === 'gcp') return 'GCP';
  if (providerId === 'azure') return 'Azure';
  if (providerId === 'aws') return 'AWS';
  return 'On-Prem';
}

/** Normalize UI/API env labels to CLI metadata.environment values. */
function toCliEnvironment(
  environment: string
): 'development' | 'staging' | 'production' {
  const e = environment.toLowerCase();
  if (e === 'prod' || e === 'production') return 'production';
  if (e === 'staging' || e === 'stage') return 'staging';
  // legacy "sandbox" maps to development (use env clone for isolation)
  return 'development';
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'grid'
  );
}

/** grid.json carries these at the top level, so they are not module inputs. */
const TOP_LEVEL_CONFIG_KEYS = new Set([
  'provider',
  'project',
  'region',
  'resources',
  'description',
]);

/**
 * Map a deploy request onto grid.json.
 *
 * The API does not feature-flag deploys — the console hides disabled types.
 * NETWORK_COMPOSER_TYPES / COMPUTE_COMPOSER_TYPES expand into the recipes the
 * CLI composers expect. Everything else is a passthrough resource (config keys
 * → Terraform module variables once CLI generic generate is wired).
 */
export function mapDeployRequestToGridConfig(req: GridDeployRequest): MappedDeploy {
  if (req.engine === 'kubernetes') {
    throw new DeployMapError('Workloads engine is not connected to apply yet', 501);
  }

  if (req.engine !== 'terraform') {
    throw new DeployMapError(`Unknown engine "${req.engine}"`, 400);
  }

  const providerId = normalizeProviderId(req.provider || asString(req.config.provider, 'aws'));
  const type = req.resourceType.trim().toLowerCase();

  if (!type) {
    throw new DeployMapError('resourceType is required');
  }

  if (Array.isArray(req.config.resources) && req.config.resources.length > 0) {
    return {
      displayProvider: toDisplayProvider(providerId),
      gridConfig: {
        provider: providerId,
        project: asString(req.config.project, 'grid'),
        region: asString(req.config.region, providerId === 'gcp' ? 'us-central1' : 'ap-south-1'),
        resources: req.config.resources,
        metadata: {
          name: req.name,
          environment: toCliEnvironment(req.environment),
          description: asString(req.config.description, req.resourceType),
        },
      },
    };
  }

  const name = slug(req.name);
  const region = asString(
    req.config.region,
    providerId === 'gcp' ? 'us-central1' : 'ap-south-1'
  );
  const project = asString(req.config.project, 'grid');

  if (NETWORK_COMPOSER_TYPES.has(type)) {
    const vpcName = `${name}-vpc`;
    const cidr = asString(req.config.cidr, '10.40.0.0/16');
    const subnets = Array.isArray(req.config.subnets)
      ? (req.config.subnets as Array<Record<string, unknown>>)
      : [{ name: `${name}-subnet`, cidr: '10.40.1.0/24' }];

    const resources: Record<string, unknown>[] = [
      { type: 'vpc', name: vpcName, cidr, description: `${req.name} network` },
    ];

    for (const s of subnets) {
      resources.push({
        type: 'subnet',
        name: asString(s.name, `${name}-subnet`),
        vpc: vpcName,
        cidr: asString(s.cidr, '10.40.1.0/24'),
        region,
        description: asString(s.description, 'Grid subnet'),
      });
    }

    return {
      displayProvider: toDisplayProvider(providerId),
      gridConfig: {
        provider: providerId,
        project,
        region,
        resources,
        metadata: {
          name: req.name,
          environment: toCliEnvironment(req.environment),
        },
      },
    };
  }

  if (COMPUTE_COMPOSER_TYPES.has(type)) {
    const vpcName = `${name}-vpc`;
    const subnetName = `${name}-subnet`;
    const machineType = asString(
      req.config.instance_type ?? req.config.machineType ?? req.config.machine_type,
      providerId === 'gcp' ? 'e2-medium' : 't3.micro'
    );

    return {
      displayProvider: toDisplayProvider(providerId),
      gridConfig: {
        provider: providerId,
        project,
        region,
        resources: [
          {
            type: 'vpc',
            name: vpcName,
            cidr: asString(req.config.vpc_cidr, '10.41.0.0/16'),
            description: `Network for ${req.name}`,
          },
          {
            type: 'subnet',
            name: subnetName,
            vpc: vpcName,
            cidr: asString(req.config.subnet_cidr, '10.41.1.0/24'),
            region,
          },
          {
            type: 'vm',
            name,
            machineType,
            subnet: subnetName,
            zone: typeof req.config.zone === 'string' ? req.config.zone : undefined,
            diskSize: asNumber(req.config.disk_size_gb ?? req.config.diskSize, 20),
            image: typeof req.config.image === 'string' ? req.config.image : undefined,
            tags: ['grid'],
            description: req.name,
          },
        ],
        metadata: {
          name: req.name,
          environment: toCliEnvironment(req.environment),
        },
      },
    };
  }

  const moduleVars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.config)) {
    if (TOP_LEVEL_CONFIG_KEYS.has(key) || value === undefined) continue;
    moduleVars[key] = value;
  }

  return {
    displayProvider: toDisplayProvider(providerId),
    gridConfig: {
      provider: providerId,
      project,
      region,
      resources: [
        {
          type,
          name,
          description: asString(req.config.description, req.name),
          ...moduleVars,
        },
      ],
      metadata: {
        name: req.name,
        environment: toCliEnvironment(req.environment),
      },
    },
  };
}
