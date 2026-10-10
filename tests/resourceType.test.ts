import { describe, expect, it } from 'vitest';
import {
  pickPrimaryResourceType,
  resolveResourceType,
} from '../src/services/resourceType';

describe('pickPrimaryResourceType', () => {
  it('prefers vm over leading security-group', () => {
    expect(
      pickPrimaryResourceType([
        { type: 'security-group' },
        { type: 'vm' },
      ])
    ).toBe('vm');
  });
});

describe('resolveResourceType', () => {
  it('prefers primary resource over resources[0] supporting type', () => {
    expect(
      resolveResourceType({
        configJson: {
          resources: [{ type: 'security-group' }, { type: 'vm' }],
        },
        gitPath: 'projects/demo/aws/dev/ec2/lab.json',
        name: 'ignored',
      })
    ).toBe('ec2');
  });

  it('uses single resources[0].type when alone', () => {
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
