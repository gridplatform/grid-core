import type { CloudProviderType } from '../types/api';

/** Display labels grouped so hyphenated folder names sit with their aliases. */
const PROVIDER_LABEL_GROUPS: ReadonlyArray<{
  label: CloudProviderType;
  aliases: readonly string[];
}> = [
  { label: 'AWS', aliases: ['aws', 'amazon'] },
  { label: 'GCP', aliases: ['gcp', 'google', 'gcloud'] },
  { label: 'Azure', aliases: ['azure', 'microsoft'] },
  { label: 'On-Prem', aliases: ['on-prem', 'onprem', 'on-premises'] },
  { label: 'Oracle', aliases: ['oracle', 'oci'] },
  { label: 'Alibaba', aliases: ['alibaba', 'aliyun'] },
  { label: 'IBM', aliases: ['ibm'] },
  { label: 'Tencent', aliases: ['tencent'] },
  { label: 'Huawei', aliases: ['huawei'] },
  { label: 'OVH', aliases: ['ovh'] },
  { label: 'Deutsche Telekom', aliases: ['deutsche-telekom', 'dt', 'otc'] },
  { label: 'CtrlS', aliases: ['ctrls'] },
  { label: 'Yotta', aliases: ['yotta'] },
  { label: 'DigitalOcean', aliases: ['digitalocean'] },
  { label: 'Linode', aliases: ['linode'] },
  { label: 'Hetzner', aliases: ['hetzner'] },
  { label: 'OpenShift', aliases: ['openshift'] },
  { label: 'Rancher', aliases: ['rancher'] },
  { label: 'Confluent Cloud', aliases: ['confluent-cloud'] },
  { label: 'Redis Enterprise', aliases: ['redis-enterprise'] },
  { label: 'Kubernetes', aliases: ['kubernetes', 'k8s'] },
];

const PROVIDER_LABELS: Readonly<Record<string, CloudProviderType>> = Object.fromEntries(
  PROVIDER_LABEL_GROUPS.flatMap(({ label, aliases }) =>
    aliases.map((alias) => [alias, label] as const)
  )
);

/** Map grid.json `provider` (or folder name) to a stable display label. */
export function providerFromConfig(cfg: Record<string, unknown>): CloudProviderType {
  const p = String(cfg.provider || 'aws').trim().toLowerCase();
  if (PROVIDER_LABELS[p]) return PROVIDER_LABELS[p];
  if (!p) return 'AWS';
  return p.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const KNOWN_CLOUD_SEGMENTS = new Set(Object.keys(PROVIDER_LABELS));
