/**
 * Families group resource types for display and mapper composers.
 * Console on/off for deploys lives only in grid-ui featureFlags.ts — not here.
 */
export type TerraformFamily =
  | 'compute'
  | 'network'
  | 'kubernetes-cluster'
  | 'database'
  | 'storage'
  | 'ai-ml'
  | 'identity'
  | 'security'
  | 'messaging'
  | 'serverless'
  | 'containers'
  | 'edge'
  | 'analytics'
  | 'cicd'
  | 'observability-infra';

/** Catalog-aligned resource types Grid can accept on deploy requests. */
export const TERRAFORM_RESOURCE_TYPES: Record<TerraformFamily, string[]> = {
  compute: [
    'vm',
    'ec2-instance',
    'compute-engine-instance',
    'virtual-machine',
    'single-vm',
    'autoscaling',
    'instance-group',
    'gpu-instance',
  ],
  network: [
    'vpc',
    'network',
    'subnet',
    'security-group',
    'network-security-group',
    'nsg',
    'alb',
    'nlb',
    'load-balancer',
    'route53',
    'cloud-dns',
    'dns',
    'nat-gateway',
    'cloud-nat',
    'eip',
    'vpn',
    'vpn-gateway',
  ],
  'kubernetes-cluster': [
    'eks',
    'eks-node-group',
    'kubernetes-engine',
    'gke',
    'gke-autopilot',
    'aks',
    'oke',
    'rosa-cluster',
    'rosa-hcp-cluster',
    'roks',
    'roks-cluster',
    'cce',
    'ack',
    'tke',
    'kubernetes',
  ],
  database: [
    'rds',
    'aurora',
    'cloud-sql-postgres',
    'cloud-sql-mysql',
    'cloud-sql-sqlserver',
    'postgresql',
    'mysql-flexible',
    'sql-server',
    'cosmosdb',
    'dynamodb',
    'dynamodb-table',
    'elasticache',
    'memorystore',
    'memorystore-redis',
    'redis',
    'redis-cache',
    'alloydb',
    'spanner',
    'bigtable',
    'firestore',
  ],
  storage: [
    's3',
    's3-bucket',
    'gcs',
    'cloud-storage',
    'storage',
    'storage-account',
    'efs',
    'filestore',
    'fsx',
    'object-storage',
  ],
  'ai-ml': [
    'sagemaker',
    'sagemaker-domain',
    'bedrock-agent',
    'bedrock-knowledge-base',
    'bedrock-guardrail',
    'vertex-ai',
    'vertex-ai-workbench',
    'openai',
    'cognitive-services',
    'machine-learning',
    'ai-search',
    'ai-foundry',
    'gpu-node-pool',
    'vllm',
    'kserve',
    'kuberay',
  ],
  identity: [
    'iam',
    'iam-role',
    'iam-policy',
    'cognito',
    'cognito-user-pool',
    'organizations',
    'service-account',
    'workload-identity',
    'azure-ad-application',
    'managed-identity',
  ],
  security: [
    'kms',
    'key-vault',
    'cloud-kms',
    'secrets-manager',
    'secret-manager',
    'guardduty',
    'wafv2',
    'waf',
    'security-hub',
    'macie',
    'acm',
    'certificate-manager',
    'shield',
    'audit-manager',
    'config',
  ],
  messaging: [
    'sns',
    'sqs',
    'eventbridge',
    'msk',
    'mq',
    'pubsub',
    'pubsub-lite',
    'service-bus',
    'event-grid',
    'kinesis',
    'kafka',
  ],
  serverless: [
    'lambda',
    'cloud-function',
    'cloud-function-gen2',
    'cloud-functions',
    'cloud-functions-gen2',
    'apigateway',
    'api-gateway',
    'appsync',
    'step-functions',
    'logic-app',
    'cloud-endpoints',
  ],
  containers: [
    'ecs',
    'ecs-service',
    'batch',
    'cloud-run',
    'cloud-run-job',
    'apprunner',
    'container-apps',
    'container-instance',
    'fargate',
  ],
  edge: [
    'cloudfront',
    'global-accelerator',
    'cdn',
    'cloud-cdn',
    'front-door',
    'media-cdn',
  ],
  analytics: [
    'glue',
    'athena',
    'athena-workgroup',
    'redshift',
    'emr',
    'bigquery',
    'dataproc',
    'synapse',
    'dataflow',
    'databricks',
    'opensearch',
  ],
  cicd: [
    'codebuild',
    'codepipeline',
    'codedeploy',
    'cloud-build',
    'devops-pipeline',
    'artifact-registry',
  ],
  'observability-infra': [
    'cloudwatch',
    'cloudwatch-log-group',
    'monitoring',
    'logging',
    'log-analytics',
    'application-insights',
    'cloud-monitoring',
    'alert-policy',
  ],
};

export function familyForResourceType(resourceType: string): TerraformFamily | null {
  const type = resourceType.toLowerCase();
  for (const [family, types] of Object.entries(TERRAFORM_RESOURCE_TYPES) as [
    TerraformFamily,
    string[],
  ][]) {
    if (types.includes(type)) return family;
  }
  return null;
}

/**
 * Types with a first-class composer in the CLI: the mapper expands them into a
 * network graph (VPC + subnets, or VPC + subnet + VM) so a single request yields
 * a working topology.
 *
 * Every other catalogued type generates through the CLI's generic catalog path,
 * where the request config is forwarded to the module bank as Terraform
 * variables. Membership here is about request shape, not about support.
 */
export const NETWORK_COMPOSER_TYPES = new Set(['vpc', 'network', 'subnet']);

export const COMPUTE_COMPOSER_TYPES = new Set([
  'vm',
  'ec2-instance',
  'compute-engine-instance',
  'virtual-machine',
  'single-vm',
]);
