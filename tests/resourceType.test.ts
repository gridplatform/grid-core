import { describe, expect, it } from 'vitest';
import { resolveResourceType } from '../src/services/resourceType';

describe('resolveResourceType', () => {
  it('prefers resources[0].type from config JSON', () => {
    expect(
      resolveResourceType({
        configJson: { resources: [{ type: 'EKS' }] },
        gitPath: 'projects/demo/aws/dev/vpc/main.json',
        name: 'ignored',
      })
    ).toBe('eks');
  });

  it('falls back to metadata.modulePath segment', () => {
    expect(
      resolveResourceType({
        configJson: { metadata: { modulePath: 'modules/aws/rds' } },
      })
    ).toBe('rds');
  });

  it('parses type from git path parent folder', () => {
    expect(
      resolveResourceType({
        gitPath: 'projects/demo/aws/dev/vpc/main.json',
      })
    ).toBe('vpc');
  });

  it('falls back to name then unknown', () => {
    expect(resolveResourceType({ name: 'My-ALB' })).toBe('my-alb');
    expect(resolveResourceType({})).toBe('unknown');
  });
});
