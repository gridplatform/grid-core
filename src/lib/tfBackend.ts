/**
 * Shared Terraform remote-backend / archive-mirror mode resolution.
 * Keep aliases aligned with grid-terraform provider folders.
 */

export type TfBackendMode =
  | 'local'
  | 's3'
  | 'gcs'
  | 'azurerm'
  | 'oci'
  | 'oss'
  | 'cos'
  | 's3compat';

/** Canonical remote modes that drive state + archive mirror. */
export const REMOTE_TF_BACKEND_MODES: readonly Exclude<TfBackendMode, 'local'>[] = [
  's3',
  'gcs',
  'azurerm',
  'oci',
  'oss',
  'cos',
  's3compat',
] as const;

/**
 * Each backend mode and the GRID_TF_BACKEND values that resolve to it.
 * Includes grid-terraform folder names and common short aliases.
 */
const BACKEND_ALIAS_GROUPS: ReadonlyArray<{
  mode: Exclude<TfBackendMode, 'local'>;
  aliases: readonly string[];
}> = [
  { mode: 's3', aliases: ['s3', 'aws', 'amazon'] },
  { mode: 'gcs', aliases: ['gcs', 'gcp', 'google'] },
  { mode: 'azurerm', aliases: ['azurerm', 'azure'] },
  { mode: 'oci', aliases: ['oci', 'oracle'] },
  { mode: 'oss', aliases: ['oss', 'alibaba', 'aliyun'] },
  { mode: 'cos', aliases: ['cos', 'tencent', 'tencentcloud'] },
  {
    mode: 's3compat',
    aliases: [
      's3compat',
      'obs',
      'huawei',
      'minio',
      'ovh',
      'ovhcloud',
      'deutsche-telekom',
      'dt',
      'otc',
      'ibm',
      'ibmcloud',
      'ctrls',
      'yotta',
    ],
  },
];

const ALIAS_TO_MODE: Readonly<Record<string, TfBackendMode>> = Object.fromEntries(
  BACKEND_ALIAS_GROUPS.flatMap(({ mode, aliases }) =>
    aliases.map((alias) => [alias, mode] as const)
  )
);

/** Raw GRID_TF_BACKEND value (trimmed, lowercased), or empty. */
export function rawTfBackendAlias(raw?: string): string {
  return (raw ?? process.env.GRID_TF_BACKEND ?? '').trim().toLowerCase();
}

export function resolveTfBackendMode(raw?: string): TfBackendMode {
  const key = rawTfBackendAlias(raw);
  if (!key) return 'local';
  return ALIAS_TO_MODE[key] ?? 'local';
}

export function isRemoteTfBackend(mode: TfBackendMode = resolveTfBackendMode()): boolean {
  return mode !== 'local';
}

type EndpointRule = {
  aliases: readonly string[];
  /** Also match when resolved mode is this (canonical backend id). */
  modes?: readonly TfBackendMode[];
  build: (ctx: { region: string; ociNamespace: string }) => string | undefined;
};

const ARCHIVE_ENDPOINT_RULES: readonly EndpointRule[] = [
  {
    aliases: ['cos', 'tencent', 'tencentcloud'],
    modes: ['cos'],
    build: ({ region }) => (region ? `https://cos.${region}.myqcloud.com` : undefined),
  },
  {
    aliases: ['oss', 'alibaba', 'aliyun'],
    modes: ['oss'],
    build: ({ region }) => (region ? `https://oss-${region}.aliyuncs.com` : undefined),
  },
  {
    aliases: ['oci', 'oracle'],
    modes: ['oci'],
    build: ({ region, ociNamespace }) =>
      region && ociNamespace
        ? `https://${ociNamespace}.compat.objectstorage.${region}.oraclecloud.com`
        : undefined,
  },
  {
    aliases: ['huawei', 'obs'],
    build: ({ region }) =>
      region ? `https://obs.${region}.myhuaweicloud.com` : undefined,
  },
  {
    aliases: ['ovh', 'ovhcloud'],
    build: ({ region }) =>
      region ? `https://s3.${region}.io.cloud.ovh.net` : undefined,
  },
  {
    aliases: ['deutsche-telekom', 'dt', 'otc'],
    build: ({ region }) =>
      region ? `https://obs.${region}.otc.t-systems.com` : undefined,
  },
];

/**
 * Default S3-compatible API endpoint for archive mirror (and hints for ops).
 * Returns undefined when the operator must set GRID_TF_S3_ENDPOINT explicitly
 * (IBM COS, CtrlS, Yotta, MinIO, custom).
 */
export function defaultArchiveS3Endpoint(opts?: {
  alias?: string;
  mode?: TfBackendMode;
  region?: string;
  ociNamespace?: string;
}): string | undefined {
  const fromEnv = (process.env.GRID_TF_S3_ENDPOINT || '').trim();
  if (fromEnv) return fromEnv;

  const alias = (opts?.alias ?? rawTfBackendAlias()).trim().toLowerCase();
  const mode = opts?.mode ?? resolveTfBackendMode(alias || undefined);
  const region = (
    opts?.region ||
    process.env.GRID_TF_STATE_REGION ||
    process.env.AWS_REGION ||
    ''
  )
    .trim()
    .toLowerCase();
  const ociNamespace = (
    opts?.ociNamespace ||
    process.env.GRID_TF_OCI_NAMESPACE ||
    ''
  ).trim();

  for (const rule of ARCHIVE_ENDPOINT_RULES) {
    const aliasHit = rule.aliases.includes(alias);
    const modeHit = rule.modes?.includes(mode) ?? false;
    if (!aliasHit && !modeHit) continue;
    return rule.build({ region, ociNamespace });
  }

  return undefined;
}

/** True when archive mirror can derive or has an S3 endpoint for this mode. */
export function archiveMirrorHasS3Endpoint(opts?: {
  alias?: string;
  mode?: TfBackendMode;
}): boolean {
  const mode = opts?.mode ?? resolveTfBackendMode(opts?.alias);
  if (mode === 's3' || mode === 'gcs' || mode === 'azurerm') return true;
  return Boolean(defaultArchiveS3Endpoint(opts));
}

export type ModuleBankArchiveEntry = {
  folder: string;
  mode: TfBackendMode;
  notes: string;
};

/**
 * Module-bank folders → state + archive path.
 * Platform overlays reuse the underlying cloud store.
 */
export const MODULE_BANK_ARCHIVE_BACKENDS: readonly ModuleBankArchiveEntry[] = [
  { folder: 'aws', mode: 's3', notes: 'AWS S3' },
  { folder: 'gcp', mode: 'gcs', notes: 'GCS' },
  { folder: 'azure', mode: 'azurerm', notes: 'Azure Blob' },
  { folder: 'oracle', mode: 'oci', notes: 'OCI Object Storage' },
  { folder: 'alibaba', mode: 'oss', notes: 'Alibaba OSS' },
  { folder: 'tencent', mode: 'cos', notes: 'Tencent COS' },
  { folder: 'huawei', mode: 's3compat', notes: 'Huawei OBS (S3 API)' },
  { folder: 'ovh', mode: 's3compat', notes: 'OVH Object Storage (S3)' },
  { folder: 'deutsche-telekom', mode: 's3compat', notes: 'OTC OBS (S3 API)' },
  { folder: 'ibm', mode: 's3compat', notes: 'IBM COS (S3 API) — set GRID_TF_S3_ENDPOINT' },
  { folder: 'ctrls', mode: 's3compat', notes: 'CtrlS object store — set GRID_TF_S3_ENDPOINT' },
  { folder: 'yotta', mode: 's3compat', notes: 'Yotta object store — set GRID_TF_S3_ENDPOINT' },
  { folder: 'openshift', mode: 's3', notes: 'use underlying cloud backend' },
  { folder: 'rancher', mode: 's3', notes: 'use underlying cloud backend' },
  { folder: 'confluent-cloud', mode: 's3', notes: 'use underlying cloud backend' },
  { folder: 'redis-enterprise', mode: 's3', notes: 'use underlying cloud backend' },
];

/** Lookup helper (folder → entry). */
export const MODULE_BANK_ARCHIVE_BACKEND: Readonly<
  Record<string, ModuleBankArchiveEntry>
> = Object.fromEntries(
  MODULE_BANK_ARCHIVE_BACKENDS.map((entry) => [entry.folder, entry])
);
