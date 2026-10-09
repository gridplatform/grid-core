import { describe, expect, it } from 'vitest';
import { providerFromConfig } from '../src/services/providerLabels';

describe('providerFromConfig', () => {
  it('maps known aliases', () => {
    expect(providerFromConfig({ provider: 'aws' })).toBe('AWS');
    expect(providerFromConfig({ provider: 'gcloud' })).toBe('GCP');
    expect(providerFromConfig({ provider: 'oci' })).toBe('Oracle');
    expect(providerFromConfig({ provider: 'k8s' })).toBe('Kubernetes');
  });

  it('defaults and title-cases unknowns', () => {
    expect(providerFromConfig({})).toBe('AWS');
    expect(providerFromConfig({ provider: 'my-cloud' })).toBe('My Cloud');
  });
});
