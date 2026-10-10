import { describe, expect, it } from 'vitest';
import {
  orderResourcesPrimaryFirst,
  pickPrimaryResourceType,
  resolveResourceType,
} from '../src/services/resourceType';

describe('pickPrimaryResourceType', () => {
  it('matches declared unit kind over other resources', () => {
    expect(
      pickPrimaryResourceType(
        [
          { type: 'alpha-helper' },
          { type: 'unit-main' },
          { type: 'beta-helper' },
        ],
        'unit-main'
      )
    ).toBe('unit-main');
  });

  it('honors explicit role=primary', () => {
    expect(
      pickPrimaryResourceType(
        [
          { type: 'alpha', role: 'support' },
          { type: 'beta', role: 'primary' },
        ],
        'gamma'
      )
    ).toBe('beta');
  });

  it('skips role=support when inferring without kind', () => {
    expect(
      pickPrimaryResourceType([
        { type: 'helper', role: 'support' },
        { type: 'main-thing' },
      ])
    ).toBe('main-thing');
  });
});

describe('orderResourcesPrimaryFirst', () => {
  it('orders by unit kind, then keeps relative order of the rest', () => {
    const ordered = orderResourcesPrimaryFirst(
      [
        { type: 'helper-a', name: 'a' },
        { type: 'unit-main', name: 'main' },
        { type: 'helper-b', name: 'b' },
      ],
      'unit-main'
    );
    expect(ordered.map((r) => r.type)).toEqual([
      'unit-main',
      'helper-a',
      'helper-b',
    ]);
  });
});

describe('resolveResourceType', () => {
  it('labels unit by stamped metadata.kind', () => {
    expect(
      resolveResourceType({
        configJson: {
          metadata: { kind: 'unit-main', name: 'demo' },
          resources: [
            { type: 'helper-a' },
            { type: 'unit-main' },
            { type: 'helper-b' },
          ],
        },
      })
    ).toBe('unit-main');
  });

  it('infers primary from resources when kind is absent', () => {
    expect(
      resolveResourceType({
        configJson: {
          resources: [
            { type: 'helper', role: 'support' },
            { type: 'anything-primary' },
          ],
        },
      })
    ).toBe('anything-primary');
  });

  it('uses single resources[0].type when alone', () => {
    expect(
      resolveResourceType({
        configJson: { resources: [{ type: 'EKS' }] },
        gitPath: 'projects/demo/aws/dev/vpc/main.json',
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
