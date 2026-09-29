import type { CloudProviderType } from '../types/api';

const PROVIDER_LABELS: Record<string, CloudProviderType> = {
  aws: 'AWS',
  amazon: 'AWS',
  gcp: 'GCP',
  google: 'GCP',
  gcloud: 'GCP',
  azure: 'Azure',
  microsoft: 'Azure',
  'on-prem': 'On-Prem',
  onprem: 'On-Prem',
  'on-premises': 'On-Prem',
  oracle: 'Oracle',
  oci: 'Oracle',
  alibaba: 'Alibaba',
  aliyun: 'Alibaba',
  ibm: 'IBM',
  tencent: 'Tencent',
  huawei: 'Huawei',
  yotta: 'Yotta',
  digitalocean: 'DigitalOcean',
  linode: 'Linode',
  hetzner: 'Hetzner',
  openshift: 'OpenShift',
  kubernetes: 'Kubernetes',
  k8s: 'Kubernetes',
};

/** Map grid.json `provider` (or folder name) to a stable display label. */
export function providerFromConfig(cfg: Record<string, unknown>): CloudProviderType {
  const p = String(cfg.provider || 'aws').trim().toLowerCase();
  if (PROVIDER_LABELS[p]) return PROVIDER_LABELS[p];
  if (!p) return 'AWS';
  return p.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const KNOWN_CLOUD_SEGMENTS = new Set(Object.keys(PROVIDER_LABELS));
