import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import type { Release, ReleaseMode, ReleaseStatus, ReleaseType } from '../types/api';

const RELEASES_FILE = () => path.join(config.dataDir, 'releases.json');

/** Serialize reads/writes — release logs append rapidly and raced on one file. */
let storeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeChain.then(fn, fn);
  storeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readUnlocked(): Promise<Release[]> {
  await fs.ensureDir(config.dataDir);
  const file = RELEASES_FILE();
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
    return Array.isArray(data) ? (data as Release[]) : [];
  } catch {
    const bak = `${file}.corrupt.${Date.now()}`;
    try {
      await fs.move(file, bak, { overwrite: true });
      console.warn(`[releases] corrupt releases.json moved to ${bak}; starting empty`);
    } catch {
      await fs.remove(file).catch(() => undefined);
    }
    await atomicWriteJson(file, []);
    return [];
  }
}

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeJSON(tmp, data, { spaces: 2 });
  await fs.move(tmp, file, { overwrite: true });
}

async function writeUnlocked(releases: Release[]): Promise<void> {
  await atomicWriteJson(RELEASES_FILE(), releases);
}

export async function listReleases(): Promise<Release[]> {
  return withLock(async () => {
    const items = await readUnlocked();
    return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  });
}

export async function getRelease(id: string): Promise<Release | undefined> {
  return withLock(async () => {
    const items = await readUnlocked();
    return items.find((r) => r.id === id);
  });
}

export async function saveRelease(release: Release): Promise<Release> {
  return withLock(async () => {
    const items = await readUnlocked();
    const idx = items.findIndex((r) => r.id === release.id);
    if (idx >= 0) items[idx] = release;
    else items.push(release);
    await writeUnlocked(items);
    return release;
  });
}

export async function createRelease(input: {
  name: string;
  type: ReleaseType;
  mode: ReleaseMode;
  environment: string;
  infrastructureId?: string;
  infrastructureName?: string;
  customCommand?: string;
  status: ReleaseStatus;
  createdBy: string;
}): Promise<Release> {
  const now = new Date().toISOString();
  const release: Release = {
    id: uuid(),
    name: input.name,
    type: input.type,
    mode: input.mode,
    status: input.status,
    environment: input.environment,
    infrastructureId: input.infrastructureId,
    infrastructureName: input.infrastructureName,
    customCommand: input.customCommand,
    logs: [],
    createdAt: now,
    createdBy: input.createdBy,
  };
  return saveRelease(release);
}

export async function appendReleaseLog(id: string, line: string): Promise<void> {
  await withLock(async () => {
    const items = await readUnlocked();
    const release = items.find((r) => r.id === id);
    if (!release) return;
    release.logs = [...(release.logs || []), line];
    await writeUnlocked(items);
  });
}

export async function findActiveRelease(): Promise<Release | undefined> {
  return withLock(async () => {
    const items = await readUnlocked();
    return items.find((r) => r.status === 'deploying');
  });
}

export async function findNextQueued(): Promise<Release | undefined> {
  return withLock(async () => {
    const items = await readUnlocked();
    return items
      .filter((r) => r.status === 'queued')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  });
}
