import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import type { Release, ReleaseMode, ReleaseStatus, ReleaseType } from '../types/api';

const RELEASES_FILE = () => path.join(config.dataDir, 'releases.json');

async function readAll(): Promise<Release[]> {
  await fs.ensureDir(config.dataDir);
  if (!(await fs.pathExists(RELEASES_FILE()))) {
    await fs.writeJSON(RELEASES_FILE(), [], { spaces: 2 });
    return [];
  }
  const data = await fs.readJSON(RELEASES_FILE());
  return Array.isArray(data) ? (data as Release[]) : [];
}

async function writeAll(releases: Release[]): Promise<void> {
  await fs.ensureDir(config.dataDir);
  await fs.writeJSON(RELEASES_FILE(), releases, { spaces: 2 });
}

export async function listReleases(): Promise<Release[]> {
  const items = await readAll();
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getRelease(id: string): Promise<Release | undefined> {
  const items = await readAll();
  return items.find((r) => r.id === id);
}

export async function saveRelease(release: Release): Promise<Release> {
  const items = await readAll();
  const idx = items.findIndex((r) => r.id === release.id);
  if (idx >= 0) items[idx] = release;
  else items.push(release);
  await writeAll(items);
  return release;
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
  const release = await getRelease(id);
  if (!release) return;
  release.logs = [...(release.logs || []), line];
  await saveRelease(release);
}

export async function findActiveRelease(): Promise<Release | undefined> {
  const items = await readAll();
  return items.find((r) => r.status === 'deploying');
}

export async function findNextQueued(): Promise<Release | undefined> {
  const items = await readAll();
  return items
    .filter((r) => r.status === 'queued')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
}
