/**
 * Normalize provider spellings from console/CLI onto one id.
 * Deploy visibility is UI-only (grid-ui featureFlags).
 */
export function normalizeProviderId(raw?: string): string {
  const p = (raw || 'aws').trim().toLowerCase();
  if (p === 'amazon' || p === 'amazon web services') return 'aws';
  if (p === 'google' || p === 'google cloud' || p === 'gcloud') return 'gcp';
  if (p === 'microsoft' || p === 'microsoft azure') return 'azure';
  if (p === 'oci' || p === 'oracle cloud') return 'oracle';
  if (p === 'ibm cloud') return 'ibm';
  if (p === 'aliyun') return 'alibaba';
  if (p === 'dt' || p === 'open telekom cloud' || p === 'otc') return 'deutsche-telekom';
  if (p === 'ctrl-s' || p === 'ctrls cloud') return 'ctrls';
  if (p === 'red hat openshift' || p === 'rosa') return 'openshift';
  return p;
}
