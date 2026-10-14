/**
 * Alert rules/channels CRUD.
 * Persist: data/alert-config.json
 * Apply: write GRID_MONITORING_CONFIG_DIR/{rules/grid-alerts.yml,alertmanager.yml} → POST /-/reload
 * List: Alertmanager GET /api/v2/alerts
 */

import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../../config';
import { readJsonSafe, writeJsonAtomic } from '../../lib/jsonFile';
import type { MonitoringAlert } from '../monitoringService';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertChannelType = 'webhook' | 'slack' | 'email';

export interface AlertChannel {
  id: string;
  name: string;
  type: AlertChannelType;
  /** webhook / Slack incoming URL */
  url?: string;
  /** email: comma-separated recipients */
  to?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRuleConfig {
  id: string;
  name: string;
  description: string;
  /** PromQL expression */
  condition: string;
  /** Prometheus `for` duration, e.g. 5m */
  forDuration: string;
  severity: AlertSeverity;
  /** Channel ids that should receive this alert */
  channelIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AlertConfigStore {
  rules: AlertRuleConfig[];
  channels: AlertChannel[];
}

const STORE_FILE = () => path.join(config.dataDir, 'alert-config.json');

function emptyStore(): AlertConfigStore {
  return { rules: [], channels: [] };
}

async function readStore(): Promise<AlertConfigStore> {
  const parsed = await readJsonSafe<Partial<AlertConfigStore>>(STORE_FILE(), {
    label: 'alert-config.json',
  });
  if (!parsed) return emptyStore();
  return {
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    channels: Array.isArray(parsed.channels) ? parsed.channels : [],
  };
}

async function writeStore(store: AlertConfigStore): Promise<void> {
  await writeJsonAtomic(STORE_FILE(), store, { spaces: 2 });
}

function yamlEscape(s: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(s) || s.includes('\n') || s.includes('"')) {
    return JSON.stringify(s);
  }
  return s;
}

function sanitizeAlertName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
  return cleaned.replace(/^_+|_+$/g, '') || 'GridAlert';
}

export function renderPrometheusRulesYaml(rules: AlertRuleConfig[]): string {
  const enabled = rules.filter((r) => r.enabled && r.condition.trim());
  const lines: string[] = [
    '# Grid Alerts → Settings',
    'groups:',
    '  - name: grid',
    '    rules:',
  ];
  if (enabled.length === 0) {
    lines.push('      []');
    return lines.join('\n') + '\n';
  }
  for (const r of enabled) {
    const alert = sanitizeAlertName(r.name);
    lines.push(`      - alert: ${alert}`);
    lines.push(`        expr: ${JSON.stringify(r.condition.trim())}`);
    lines.push(`        for: ${r.forDuration || '5m'}`);
    lines.push('        labels:');
    lines.push(`          severity: ${r.severity}`);
    lines.push(`          grid_rule_id: ${r.id}`);
    lines.push('        annotations:');
    lines.push(`          summary: ${yamlEscape(r.name)}`);
    lines.push(
      `          description: ${yamlEscape(r.description || r.name)}`
    );
  }
  return lines.join('\n') + '\n';
}

export function renderAlertmanagerYaml(
  channels: AlertChannel[],
  rules: AlertRuleConfig[]
): string {
  const enabledChannels = channels.filter((c) => c.enabled);
  const lines: string[] = [
    '# Grid Alerts → Settings',
    'global:',
    '  resolve_timeout: 5m',
    '',
    'route:',
    '  receiver: grid-null',
    "  group_by: ['alertname', 'severity']",
    '  group_wait: 30s',
    '  group_interval: 5m',
    '  repeat_interval: 4h',
  ];

  const routeLines: string[] = [];
  for (const r of rules.filter((x) => x.enabled)) {
    const chIds = r.channelIds.filter((id) =>
      enabledChannels.some((c) => c.id === id)
    );
    if (chIds.length === 0) continue;
    routeLines.push('    - matchers:');
    routeLines.push(`        - grid_rule_id="${r.id}"`);
    routeLines.push(`      receiver: grid-${chIds[0]}`);
    routeLines.push('      continue: false');
  }
  if (routeLines.length > 0) {
    lines.push('  routes:');
    lines.push(...routeLines);
  }

  lines.push('');
  lines.push('receivers:');
  lines.push('  - name: grid-null');

  for (const c of enabledChannels) {
    if (c.type === 'webhook' || c.type === 'slack') {
      const url = (c.url || '').trim();
      if (!url) continue;
      lines.push(`  - name: grid-${c.id}`);
      if (c.type === 'slack') {
        lines.push('    slack_configs:');
        lines.push(`      - api_url: ${yamlEscape(url)}`);
        lines.push('        send_resolved: true');
      } else {
        lines.push('    webhook_configs:');
        lines.push(`      - url: ${yamlEscape(url)}`);
        lines.push('        send_resolved: true');
      }
    } else if (c.type === 'email') {
      const to = (c.to || '').trim();
      if (!to) continue;
      lines.push(`  - name: grid-${c.id}`);
      lines.push('    email_configs:');
      lines.push(`      - to: ${yamlEscape(to)}`);
      lines.push('        send_resolved: true');
    }
  }

  return lines.join('\n') + '\n';
}

async function postLifecycleReload(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, '')}/-/reload`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.alertmanager.timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', signal: ctrl.signal });
    if (!res.ok && res.status !== 200) {
      throw new Error(`reload ${url} → HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(t);
  }
}

/** Write YAML under monitoring config dir and reload Prometheus + Alertmanager. */
export async function syncAlertConfigToHost(store?: AlertConfigStore): Promise<{
  rulesPath: string;
  alertmanagerPath: string;
  reloaded: { prometheus: boolean; alertmanager: boolean };
  errors: string[];
}> {
  const s = store ?? (await readStore());
  const dir = config.monitoringConfigDir;
  const rulesDir = path.join(dir, 'rules');
  const rulesPath = path.join(rulesDir, 'grid-alerts.yml');
  const alertmanagerPath = path.join(dir, 'alertmanager.yml');

  await fs.ensureDir(rulesDir);
  await fs.writeFile(rulesPath, renderPrometheusRulesYaml(s.rules), 'utf8');
  await fs.writeFile(
    alertmanagerPath,
    renderAlertmanagerYaml(s.channels, s.rules),
    'utf8'
  );

  const errors: string[] = [];
  const reloaded = { prometheus: false, alertmanager: false };

  if (config.prometheus.url) {
    try {
      await postLifecycleReload(config.prometheus.url);
      reloaded.prometheus = true;
    } catch (err) {
      errors.push(
        `Prometheus reload failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    errors.push('GRID_PROMETHEUS_URL unset — wrote rules file only');
  }

  if (config.alertmanager.url) {
    try {
      await postLifecycleReload(config.alertmanager.url);
      reloaded.alertmanager = true;
    } catch (err) {
      errors.push(
        `Alertmanager reload failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    errors.push('GRID_ALERTMANAGER_URL unset — wrote alertmanager.yml only');
  }

  return { rulesPath, alertmanagerPath, reloaded, errors };
}

export async function listAlertRules(): Promise<AlertRuleConfig[]> {
  return (await readStore()).rules;
}

export async function listAlertChannels(): Promise<AlertChannel[]> {
  return (await readStore()).channels;
}

export async function upsertAlertRule(
  input: Partial<AlertRuleConfig> & {
    name: string;
    condition: string;
  }
): Promise<AlertRuleConfig> {
  const store = await readStore();
  const now = new Date().toISOString();
  const existing = input.id
    ? store.rules.find((r) => r.id === input.id)
    : undefined;

  const rule: AlertRuleConfig = {
    id: existing?.id || input.id || uuid(),
    name: input.name.trim(),
    description: (input.description ?? existing?.description ?? '').trim(),
    condition: input.condition.trim(),
    forDuration: (input.forDuration ?? existing?.forDuration ?? '5m').trim() || '5m',
    severity: input.severity ?? existing?.severity ?? 'warning',
    channelIds: input.channelIds ?? existing?.channelIds ?? [],
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) {
    store.rules = store.rules.map((r) => (r.id === rule.id ? rule : r));
  } else {
    store.rules.push(rule);
  }
  await writeStore(store);
  await syncAlertConfigToHost(store);
  return rule;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  const store = await readStore();
  const before = store.rules.length;
  store.rules = store.rules.filter((r) => r.id !== id);
  if (store.rules.length === before) return false;
  await writeStore(store);
  await syncAlertConfigToHost(store);
  return true;
}

export async function upsertAlertChannel(
  input: Partial<AlertChannel> & { name: string; type: AlertChannelType }
): Promise<AlertChannel> {
  const store = await readStore();
  const now = new Date().toISOString();
  const existing = input.id
    ? store.channels.find((c) => c.id === input.id)
    : undefined;

  const channel: AlertChannel = {
    id: existing?.id || input.id || uuid(),
    name: input.name.trim(),
    type: input.type,
    url: input.url ?? existing?.url,
    to: input.to ?? existing?.to,
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) {
    store.channels = store.channels.map((c) => (c.id === channel.id ? channel : c));
  } else {
    store.channels.push(channel);
  }
  await writeStore(store);
  await syncAlertConfigToHost(store);
  return channel;
}

export async function deleteAlertChannel(id: string): Promise<boolean> {
  const store = await readStore();
  const before = store.channels.length;
  store.channels = store.channels.filter((c) => c.id !== id);
  // Drop channel refs from rules
  store.rules = store.rules.map((r) => ({
    ...r,
    channelIds: r.channelIds.filter((cid) => cid !== id),
  }));
  if (store.channels.length === before) return false;
  await writeStore(store);
  await syncAlertConfigToHost(store);
  return true;
}

interface AmAlert {
  fingerprint?: string;
  status?: { state?: string };
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  updatedAt?: string;
  endsAt?: string;
}

function mapAmAlert(a: AmAlert, forceResolved = false): MonitoringAlert {
  const labels = a.labels || {};
  const ann = a.annotations || {};
  const state = a.status?.state || 'active';
  let status: MonitoringAlert['status'] = 'firing';
  if (forceResolved) {
    status = 'resolved';
  } else if (state === 'suppressed') {
    status = 'suppressed';
  } else {
    status = 'firing';
  }
  const severity = (labels.severity as MonitoringAlert['severity']) || 'warning';
  return {
    id: a.fingerprint || `am-${labels.alertname}-${a.startsAt}`,
    ruleName: labels.alertname || 'alert',
    resource: labels.grid_unit_id || labels.instance || labels.job || '—',
    resourceId: labels.grid_unit_id || labels.grid_rule_id,
    severity: ['critical', 'warning', 'info'].includes(severity) ? severity : 'warning',
    status,
    message: ann.description || ann.summary || labels.alertname || 'Alert',
    startedAt: a.startsAt || a.updatedAt || new Date().toISOString(),
  };
}

async function fetchAmAlerts(pathQuery: string): Promise<AmAlert[]> {
  const base = config.alertmanager.url?.trim();
  if (!base) return [];
  const url = `${base.replace(/\/+$/, '')}/api/v2/alerts?${pathQuery}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.alertmanager.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Alertmanager alerts → HTTP ${res.status}`);
    }
    const body = (await res.json()) as AmAlert[];
    return Array.isArray(body) ? body : [];
  } finally {
    clearTimeout(t);
  }
}

/** List firings: firing | suppressed | resolved (from Alertmanager). */
export async function listAlertmanagerFirings(): Promise<MonitoringAlert[]> {
  if (!config.alertmanager.url?.trim()) return [];

  const [activeOrSuppressed, resolved] = await Promise.all([
    fetchAmAlerts('active=true&silenced=true&inhibited=true'),
    fetchAmAlerts('active=false&silenced=true&inhibited=true'),
  ]);

  const byId = new Map<string, MonitoringAlert>();
  for (const a of activeOrSuppressed) {
    const mapped = mapAmAlert(a, false);
    byId.set(mapped.id, mapped);
  }
  for (const a of resolved) {
    const mapped = mapAmAlert(a, true);
    if (!byId.has(mapped.id)) byId.set(mapped.id, mapped);
  }

  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
