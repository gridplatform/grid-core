import { describe, expect, it } from 'vitest';
import { defaultApprovalRequired } from '../src/services/approvalPolicyStore';
import { requiredLevelForReleaseMode, releaseDomainForMode } from '../src/services/accessService';

describe('approval defaults', () => {
  it('defaults development off and staging/production on', () => {
    expect(defaultApprovalRequired('development')).toBe(false);
    expect(defaultApprovalRequired('dev')).toBe(false);
    expect(defaultApprovalRequired('staging')).toBe(true);
    expect(defaultApprovalRequired('production')).toBe(true);
    expect(defaultApprovalRequired('prod-eu')).toBe(true);
  });
});

describe('release access mapping', () => {
  it('maps modes to required levels and domains', () => {
    expect(requiredLevelForReleaseMode('plan')).toBe('read');
    expect(requiredLevelForReleaseMode('apply')).toBe('write');
    expect(requiredLevelForReleaseMode('destroy')).toBe('write');
    expect(releaseDomainForMode('apply')).toBe('infrastructure');
    expect(releaseDomainForMode('apply', 'kubernetes')).toBe('kubernetes');
  });
});
