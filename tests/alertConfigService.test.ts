import { describe, expect, it } from 'vitest';
import {
  renderAlertmanagerYaml,
  renderPrometheusRulesYaml,
  type AlertChannel,
  type AlertRuleConfig,
} from '../src/services/monitoring/alertConfigService';

const rule = (partial: Partial<AlertRuleConfig> & Pick<AlertRuleConfig, 'id' | 'name' | 'condition'>): AlertRuleConfig => ({
  description: '',
  forDuration: '5m',
  severity: 'warning',
  channelIds: [],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...partial,
});

const channel = (partial: Partial<AlertChannel> & Pick<AlertChannel, 'id' | 'name' | 'type'>): AlertChannel => ({
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...partial,
});

describe('renderPrometheusRulesYaml', () => {
  it('emits empty rules list when none enabled', () => {
    const yml = renderPrometheusRulesYaml([]);
    expect(yml).toContain('rules:');
    expect(yml).toContain('[]');
  });

  it('renders PromQL with quoted expr', () => {
    const yml = renderPrometheusRulesYaml([
      rule({
        id: 'r1',
        name: 'TargetDown',
        condition: 'up == 0',
        channelIds: ['c1'],
      }),
    ]);
    expect(yml).toContain('alert: TargetDown');
    expect(yml).toContain('expr: "up == 0"');
    expect(yml).toContain('grid_rule_id: r1');
  });
});

describe('renderAlertmanagerYaml', () => {
  it('keeps null receiver when no channels', () => {
    const yml = renderAlertmanagerYaml([], []);
    expect(yml).toContain('receiver: grid-null');
    expect(yml).toContain('- name: grid-null');
    expect(yml).not.toContain('routes:');
  });

  it('routes rule to webhook channel', () => {
    const yml = renderAlertmanagerYaml(
      [channel({ id: 'c1', name: 'hook', type: 'webhook', url: 'http://example.com/hook' })],
      [rule({ id: 'r1', name: 'Down', condition: 'up == 0', channelIds: ['c1'] })]
    );
    expect(yml).toContain('grid_rule_id="r1"');
    expect(yml).toContain('receiver: grid-c1');
    expect(yml).toContain('webhook_configs:');
    expect(yml).toContain('http://example.com/hook');
  });
});
