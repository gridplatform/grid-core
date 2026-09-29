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

async function readStore(): Promise<StoreShape> {
  await fs.ensureDir(config.dataDir);
  if (!(await fs.pathExists(STORE_FILE()))) {
    const empty: StoreShape = { infrastructures: [], deployments: [] };
    await fs.writeJSON(STORE_FILE(), empty, { spaces: 2 });
    return empty;
  }
  return fs.readJSON(STORE_FILE());
}

async function writeStore(store: StoreShape): Promise<void> {
  await fs.ensureDir(config.dataDir);
  await fs.writeJSON(STORE_FILE(), store, { spaces: 2 });
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
  const store = await readStore();
  const idx = store.infrastructures.findIndex((i) => i.id === infra.id);
  if (idx >= 0) {
    store.infrastructures[idx] = infra;
  } else {
    store.infrastructures.push(infra);
  }
  await writeStore(store);
  return infra;
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
  const store = await readStore();
  const idx = store.deployments.findIndex((d) => d.id === deployment.id);
  if (idx >= 0) {
    store.deployments[idx] = deployment;
  } else {
    store.deployments.push(deployment);
  }
  await writeStore(store);
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
  // Serialize appends so concurrent stdout/stderr chunks don't drop lines
  const prev = appendChains.get(deploymentId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const deployment = await getDeployment(deploymentId);
      if (!deployment) return;
      deployment.logs.push(line);
      await saveDeployment(deployment);
    })
    .catch(() => undefined);
  appendChains.set(deploymentId, next);
  await next;
}

const appendChains = new Map<string, Promise<void | undefined>>();

