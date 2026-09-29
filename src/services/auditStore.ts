import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../config';

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

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeJSON(tmp, data, { spaces: 2 });
  await fs.move(tmp, file, { overwrite: true });
}

async function readUnlocked(): Promise<AuditEvent[]> {
  await fs.ensureDir(config.dataDir);
  const file = AUDIT_FILE();
  if (!(await fs.pathExists(file))) {
    await atomicWriteJson(file, []);
    return [];
  }
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.trim()) {
      await atomicWriteJson(file, []);
      return [];
    }
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? (data as AuditEvent[]) : [];
  } catch {
    const bak = `${file}.corrupt.${Date.now()}`;
    try {
      await fs.move(file, bak, { overwrite: true });
      console.warn(`[audit] corrupt audit-log.json moved to ${bak}; starting empty`);
    } catch {
      await fs.remove(file).catch(() => undefined);
    }
    await atomicWriteJson(file, []);
    return [];
  }
}

async function writeUnlocked(events: AuditEvent[]): Promise<void> {
  await atomicWriteJson(AUDIT_FILE(), events.slice(0, MAX_EVENTS));
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
