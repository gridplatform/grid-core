import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import type { Deployment, Infrastructure } from '../types/api';

interface StoreShape {
  infrastructures: Infrastructure[];
  deployments: Deployment[];
}

const STORE_FILE = () => path.join(config.dataDir, 'store.json');

/** In-memory copy of store.json — avoids re-parsing multi-MB JSON on every list call. */
let memoryStore: StoreShape | null = null;

/** Serialize all store reads/writes — sync fans out many saves and raced on one tmp path. */
let storeChain: Promise<unknown> = Promise.resolve();

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeChain.then(fn, fn);
  storeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readStoreUnlocked(): Promise<StoreShape> {
  if (memoryStore) return memoryStore;

  await fs.ensureDir(config.dataDir);
  const file = STORE_FILE();
  const empty: StoreShape = { infrastructures: [], deployments: [] };

  if (!(await fs.pathExists(file))) {
    await fs.writeJSON(file, empty);
    memoryStore = empty;
    return memoryStore;
  }

  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.trim()) {
      await fs.writeJSON(file, empty);
      memoryStore = empty;
      return memoryStore;
    }
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    memoryStore = {
      infrastructures: Array.isArray(parsed.infrastructures) ? parsed.infrastructures : [],
      deployments: Array.isArray(parsed.deployments) ? parsed.deployments : [],
    };
    return memoryStore;
  } catch {
    const bak = `${file}.corrupt.${Date.now()}`;
    try {
      await fs.move(file, bak, { overwrite: true });
    } catch {
      try {
        await fs.remove(file);
      } catch {
        /* ignore */
      }
    }
    await fs.writeJSON(file, empty);
    memoryStore = empty;
    return memoryStore;
  }
}

async function writeStoreUnlocked(store: StoreShape): Promise<void> {
  await fs.ensureDir(config.dataDir);
  const file = STORE_FILE();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  // Compact JSON keeps large catalogs smaller on disk and faster to rewrite.
  await fs.writeJSON(tmp, store);
  await fs.move(tmp, file, { overwrite: true });
  memoryStore = store;
}

async function readStore(): Promise<StoreShape> {
  return withStoreLock(() => readStoreUnlocked());
}

async function writeStore(store: StoreShape): Promise<void> {
  return withStoreLock(() => writeStoreUnlocked(store));
}

/**
 * Read-modify-write under the same lock so concurrent sync saves don't clobber each other.
 */
async function updateStore(mutator: (store: StoreShape) => void): Promise<StoreShape> {
  return withStoreLock(async () => {
    const store = await readStoreUnlocked();
    mutator(store);
    await writeStoreUnlocked(store);
    return store;
  });
}

export async function listInfrastructures(): Promise<Infrastructure[]> {
  const store = await readStore();
  return store.infrastructures;
}

export async function getInfrastructure(id: string): Promise<Infrastructure | undefined> {
  const store = await readStore();
  return store.infrastructures.find((i) => i.id === id);
}

export async function saveInfrastructure(infra: Infrastructure): Promise<Infrastructure> {
  await updateStore((store) => {
    const idx = store.infrastructures.findIndex((i) => i.id === infra.id);
    if (idx >= 0) store.infrastructures[idx] = infra;
    else store.infrastructures.push(infra);
  });
  return infra;
}

export async function deleteInfrastructure(id: string): Promise<boolean> {
  let removed = false;
  await updateStore((store) => {
    const before = store.infrastructures.length;
    store.infrastructures = store.infrastructures.filter((i) => i.id !== id);
    if (store.infrastructures.length === before) return;
    store.deployments = store.deployments.filter((d) => d.infrastructureId !== id);
    removed = true;
  });
  return removed;
}

export async function deleteDeploymentsForInfrastructure(infrastructureId: string): Promise<number> {
  let removed = 0;
  await updateStore((store) => {
    const before = store.deployments.length;
    store.deployments = store.deployments.filter((d) => d.infrastructureId !== infrastructureId);
    removed = before - store.deployments.length;
  });
  return removed;
}

/** Drop in-flight runs superseded by a newer plan/apply/destroy. */
export async function cancelActiveDeploymentsForInfrastructure(
  infrastructureId: string,
  exceptId?: string
): Promise<number> {
  let removed = 0;
  await updateStore((store) => {
    const before = store.deployments.length;
    store.deployments = store.deployments.filter((d) => {
      if (d.infrastructureId !== infrastructureId) return true;
      if (exceptId && d.id === exceptId) return true;
      if (d.status !== 'pending' && d.status !== 'planning' && d.status !== 'running') return true;
      return false;
    });
    removed = before - store.deployments.length;
  });
  return removed;
}

/**
 * Drop deployments whose infrastructure no longer exists.
 * Also drop in-flight runs that are older than a finished run for the same infra.
 */
export async function reconcileDeployments(): Promise<{ removed: number; cancelled: number }> {
  let removed = 0;
  let cancelled = 0;

  await updateStore((store) => {
    const byId = new Map(store.infrastructures.map((i) => [i.id, i]));
    const kept: typeof store.deployments = [];
    for (const d of store.deployments) {
      const infra = byId.get(d.infrastructureId);
      if (!infra) {
        removed += 1;
        continue;
      }
      kept.push(d);
    }

    const latestFinished = new Map<string, string>();
    for (const d of kept) {
      if (d.status !== 'success' && d.status !== 'failed' && d.status !== 'cancelled') continue;
      const prev = latestFinished.get(d.infrastructureId);
      if (!prev || d.startedAt > prev) latestFinished.set(d.infrastructureId, d.startedAt);
    }

    const pruned: typeof store.deployments = [];
    for (const d of kept) {
      const finishedAt = latestFinished.get(d.infrastructureId);
      if (
        finishedAt &&
        d.startedAt < finishedAt &&
        (d.status === 'pending' || d.status === 'planning' || d.status === 'running')
      ) {
        cancelled += 1;
        continue;
      }
      pruned.push(d);
    }

    store.deployments = pruned;
  });

  return { removed, cancelled };
}

export async function createInfrastructure(
  input: Omit<Infrastructure, 'id' | 'createdAt' | 'updatedAt' | 'userId'> & {
    userId?: string;
    id?: string;
  }
): Promise<Infrastructure> {
  const now = new Date().toISOString();
  const infra: Infrastructure = {
    id: input.id || uuid(),
    userId: input.userId || config.demoUser.id,
    name: input.name,
    environment: input.environment,
    provider: input.provider,
    configJson: input.configJson,
    gitRepo: input.gitRepo,
    gitBranch: input.gitBranch,
    gitPath: input.gitPath,
    gitCommit: input.gitCommit,
    gitContentHash: input.gitContentHash,
    lastAppliedHash: input.lastAppliedHash,
    project: input.project,
    status: input.status || 'pending',
    autoApprove: input.autoApprove ?? true,
    driftDetection: input.driftDetection ?? false,
    createdAt: now,
    updatedAt: now,
  };
  return saveInfrastructure(infra);
}

export async function listDeployments(): Promise<Deployment[]> {
  const store = await readStore();
  return store.deployments;
}

export async function getDeployment(id: string): Promise<Deployment | undefined> {
  const store = await readStore();
  return store.deployments.find((d) => d.id === id);
}

export async function saveDeployment(deployment: Deployment): Promise<Deployment> {
  await updateStore((store) => {
    const idx = store.deployments.findIndex((d) => d.id === deployment.id);
    if (idx >= 0) store.deployments[idx] = deployment;
    else store.deployments.push(deployment);
  });
  return deployment;
}

export async function createDeployment(
  infrastructureId: string,
  triggeredBy: string,
  meta?: {
    name?: string;
    engine?: string;
    resourceType?: string;
    provider?: string;
    environment?: string;
    mode?: import('../types/api').LifecycleMode;
  }
): Promise<Deployment> {
  const deployment: Deployment = {
    id: uuid(),
    infrastructureId,
    status: 'pending',
    mode: meta?.mode,
    progress: 0,
    startedAt: new Date().toISOString(),
    logs: [],
    triggeredBy,
    name: meta?.name,
    engine: meta?.engine,
    resourceType: meta?.resourceType,
    provider: meta?.provider,
    environment: meta?.environment,
  };
  return saveDeployment(deployment);
}

export async function appendDeploymentLog(
  deploymentId: string,
  line: string
): Promise<void> {
  const prev = appendChains.get(deploymentId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await updateStore((store) => {
        const deployment = store.deployments.find((d) => d.id === deploymentId);
        if (!deployment) return;
        deployment.logs.push(line);
      });
    })
    .catch(() => undefined);
  appendChains.set(deploymentId, next);
  await next;
}

const appendChains = new Map<string, Promise<void | undefined>>();

