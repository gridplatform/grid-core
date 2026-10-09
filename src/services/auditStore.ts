import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { readJsonSafe, writeJsonAtomic } from '../lib/jsonFile';

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.register'
  | 'auth.user.create'
  | 'auth.user.update'
  | 'release.create'
  | 'release.finish'
  | 'release.cancel'
  | 'infra.create'
  | 'infra.update'
  | 'infra.restore_config'
  | 'infra.delete'
  | 'infra.drift_check'
  | 'gitops.settings.update'
  | 'gitops.sync'
  | 'module_bank.sync'
  | 'api_key.create'
  | 'api_key.revoke'
  | 'environment.view';

export interface AuditEvent {
  id: string;
  at: string;
  action: AuditAction | string;
  actor: string;
  actorRole?: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  summary: string;
  details?: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'denied';
}

const AUDIT_FILE = () => path.join(config.dataDir, 'audit-log.json');
const MAX_EVENTS = 5_000;

let storeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeChain.then(fn, fn);
  storeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readUnlocked(): Promise<AuditEvent[]> {
  await fs.ensureDir(config.dataDir);
  const file = AUDIT_FILE();
  const data = await readJsonSafe<unknown>(file, { label: 'audit-log.json' });
  if (data === null) {
    await writeJsonAtomic(file, []);
    return [];
  }
  return Array.isArray(data) ? (data as AuditEvent[]) : [];
}

async function writeUnlocked(events: AuditEvent[]): Promise<void> {
  await writeJsonAtomic(AUDIT_FILE(), events.slice(0, MAX_EVENTS));
}

export async function listAuditEvents(limit = 200): Promise<AuditEvent[]> {
  return withLock(async () => {
    const items = await readUnlocked();
    return items.slice(0, Math.max(1, Math.min(limit, MAX_EVENTS)));
  });
}

export async function recordAudit(input: {
  action: AuditAction | string;
  actor: string;
  actorRole?: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  summary: string;
  details?: Record<string, unknown>;
  outcome?: 'success' | 'failure' | 'denied';
}): Promise<AuditEvent> {
  return withLock(async () => {
    const event: AuditEvent = {
      id: uuid(),
      at: new Date().toISOString(),
      action: input.action,
      actor: input.actor,
      actorRole: input.actorRole,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceName: input.resourceName,
      summary: input.summary,
      details: input.details,
      outcome: input.outcome || 'success',
    };
    const items = await readUnlocked();
    items.unshift(event);
    await writeUnlocked(items);
    return event;
  });
}
