import path from 'path';
import fs from 'fs-extra';
import { config } from '../config';
import { writeJsonAtomic } from '../lib/jsonFile';
import type { Infrastructure, ResourceStatus } from '../types/api';
import {
  createInfrastructure,
  deleteInfrastructure,
  getInfrastructure,
  listInfrastructures,
  saveInfrastructure,
} from '../store/memoryStore';
import { hashContent } from './gitopsHash';
import {
  environmentFromMetadata,
  nameFromConfig,
} from './configFields';
import { projectSlugFromGitPath } from './projectsService';
import { KNOWN_CLOUD_SEGMENTS, providerFromConfig } from './providerLabels';
import { invalidateConfigDiscoveryCache } from './configDiscovery';
import { ensureUnitIdInConfig } from './unitIdentity';
import { resolveUnderRoot } from '../lib/safePath';

const SKIP_DIRS = new Set(['.git', '.grid', 'node_modules', 'scripts', 'archive']);

/** Prefer metadata, then path heuristics under GRID_CONFIG_ROOT. */
function environmentFromConfig(cfg: Record<string, unknown>, gitPath: string): string {
  const fromMeta = environmentFromMetadata(cfg);
  if (fromMeta) return fromMeta;
  const parts = gitPath.split('/');
  if (parts[0] === '.ephemeral' && parts[1]?.includes('--')) {
    return parts[1];
  }
  const cloudIdx = parts.findIndex((p) => KNOWN_CLOUD_SEGMENTS.has(p.toLowerCase()));
  if (cloudIdx >= 0 && parts[cloudIdx + 1]) return parts[cloudIdx + 1];
  for (const p of parts) {
    if (/^(dev|development|staging|stage|prod|production|qa|test|sandbox)([-_].+)?$/i.test(p)) {
      return p;
    }
  }
  return 'development';
}

function hadCloudPresence(infra: Infrastructure): boolean {
  if (infra.lastAppliedHash) return true;
  return ['running', 'error', 'degraded', 'stale'].includes(infra.status);
}

async function discoverJsonFiles(root: string): Promise<Array<{ abs: string; gitPath: string }>> {
  const found: Array<{ abs: string; gitPath: string }> = [];
  if (!(await fs.pathExists(root))) return found;

  const projectsDir = path.join(root, 'projects');
  const hasProjects =
    (await fs.pathExists(projectsDir)) &&
    (await fs.readdir(projectsDir, { withFileTypes: true })).some(
      (e) => e.isDirectory() && !e.name.startsWith('.')
    );

  const skipNames = new Set([
    '.grid-clone.json',
    'catalog_index.json',
    'project.json',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ]);

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (
          hasProjects &&
          dir === root &&
          ['aws', 'gcp', 'azure', 'onprem', 'on-prem'].includes(ent.name)
        ) {
          continue;
        }
        await walk(abs);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      if (skipNames.has(ent.name.toLowerCase())) continue;
      // Path heuristic only — validate on read during upsert (keeps large catalogs fast).
      const gitPath = path.relative(root, abs).split(path.sep).join('/');
      found.push({ abs, gitPath });
    }
  };

  await walk(hasProjects ? projectsDir : root);
  return found;
}

type SyncStats = { synced: number; stale: number; removed: number };

const SYNC_TTL_MS = 60_000;
let lastSyncAt = 0;
let lastSyncResult: SyncStats | null = null;
let syncInFlight: Promise<SyncStats> | null = null;

/**
 * Reconcile the store with GRID_CONFIG_ROOT intent JSON.
 *
 * - Upsert every config-backed unit.
 * - Drop orphans with no gitPath (API leftovers) and destroyed units not in config.
 * - If JSON was removed but cloud state may still exist → status `stale` (UI prompts destroy or restore).
 *
 * Cached for SYNC_TTL_MS so list endpoints do not re-parse thousands of files every request.
 */
export async function syncInfrastructuresFromConfigRoot(opts?: {
  force?: boolean;
}): Promise<SyncStats> {
  const force = opts?.force === true;
  const now = Date.now();
  if (!force && lastSyncResult && now - lastSyncAt < SYNC_TTL_MS) {
    return lastSyncResult;
  }
  if (syncInFlight) return syncInFlight;

  syncInFlight = runConfigRootSync()
    .then((result) => {
      lastSyncAt = Date.now();
      lastSyncResult = result;
      return result;
    })
    .finally(() => {
      syncInFlight = null;
    });

  return syncInFlight;
}

async function runConfigRootSync(): Promise<SyncStats> {
  const root = config.configRoot;
  const files = await discoverJsonFiles(root);
  const seen = new Set(files.map((f) => f.gitPath));
  let synced = 0;
  let stale = 0;
  let removed = 0;

  const CONCURRENCY = 24;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (file) => {
        let cfg: Record<string, unknown>;
        try {
          cfg = (await fs.readJSON(file.abs)) as Record<string, unknown>;
        } catch {
          return 0;
        }
        if (typeof cfg.provider !== 'string' || !Array.isArray(cfg.resources)) return 0;

        // Join key: metadata.id if present, else UUID v5(gitPath). Do not write
        // id back into desired-state (operators should not need to commit it).
        // TF state / archive stay path-based. Path derivation alone is durable
        // across Grid store wipe — same path → same id, no DB required.
        const { id } = ensureUnitIdInConfig(file.gitPath, cfg);
        const unitCfg = cfg;
        const contentHash = hashContent(unitCfg);
        const folderName = path.basename(path.dirname(file.gitPath));
        const existing = await getInfrastructure(id);
        const project =
          (typeof (unitCfg.metadata as { project?: string } | undefined)?.project === 'string'
            ? (unitCfg.metadata as { project: string }).project
            : null) || projectSlugFromGitPath(file.gitPath);

        if (!existing) {
          await createInfrastructure({
            id,
            name: nameFromConfig(unitCfg, folderName),
            environment: environmentFromConfig(unitCfg, file.gitPath),
            provider: providerFromConfig(unitCfg),
            configJson: unitCfg,
            status: 'pending',
            autoApprove: true,
            driftDetection: true,
            gitPath: file.gitPath,
            gitContentHash: contentHash,
            project,
          });
        } else if (
          existing.gitContentHash === contentHash &&
          existing.status !== 'stale' &&
          existing.status !== 'destroyed'
        ) {
          // Unchanged and active — skip write.
        } else {
          // Intent still present: revive stale/destroyed → pending/running.
          // Destroy never removes config-backed units; sync brings them back to pending.
          const restoredStatus: ResourceStatus =
            existing.status === 'destroyed'
              ? 'pending'
              : existing.status === 'stale'
                ? existing.lastAppliedHash
                  ? 'running'
                  : 'pending'
                : existing.status;

          await saveInfrastructure({
            ...existing,
            name: nameFromConfig(unitCfg, existing.name),
            environment: environmentFromConfig(unitCfg, file.gitPath),
            provider: providerFromConfig(unitCfg),
            configJson: unitCfg,
            gitPath: file.gitPath,
            gitContentHash: contentHash,
            project,
            status: restoredStatus,
            lastAppliedHash:
              existing.status === 'destroyed' ? undefined : existing.lastAppliedHash,
            updatedAt: new Date().toISOString(),
          });
        }
        return 1;
      })
    );
    synced += results.reduce((a: number, b: number) => a + b, 0);
  }

  for (const infra of await listInfrastructures()) {
    if (!infra.gitPath) {
      await deleteInfrastructure(infra.id);
      removed += 1;
      continue;
    }

    if (seen.has(infra.gitPath)) continue;

    if (infra.status === 'destroyed' || !hadCloudPresence(infra)) {
      await deleteInfrastructure(infra.id);
      removed += 1;
      continue;
    }

    if (infra.status !== 'stale') {
      await saveInfrastructure({
        ...infra,
        status: 'stale',
        updatedAt: new Date().toISOString(),
      });
      stale += 1;
    }
  }

  invalidateConfigDiscoveryCache();
  return { synced, stale, removed };
}

/** Write stored configJson back to gitPath under GRID_CONFIG_ROOT. */
export async function restoreInfrastructureToConfig(
  infra: Infrastructure
): Promise<Infrastructure> {
  if (!infra.gitPath) {
    throw new Error('Cannot restore: infrastructure has no config path');
  }
  const abs = resolveUnderRoot(config.configRoot, infra.gitPath);
  await fs.ensureDir(path.dirname(abs));
  await writeJsonAtomic(abs, infra.configJson);

  const next: Infrastructure = {
    ...infra,
    status: infra.lastAppliedHash ? 'running' : 'pending',
    gitContentHash: hashContent(infra.configJson),
    updatedAt: new Date().toISOString(),
  };
  return saveInfrastructure(next);
}
