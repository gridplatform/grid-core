import path from 'path';
import fs from 'fs-extra';
import { config } from '../config';
import {
  defaultApprovalRequired,
  listApprovalPolicies,
} from './approvalPolicyStore';

const SKIP_DIRS = new Set([
  '.grid',
  '.git',
  'node_modules',
  'scripts',
  'archive',
  '.ephemeral',
  'modules',
]);

/** Well-known env names get stable ordering; anything else is still auto-detected. */
const ENV_ORDER: Record<string, number> = {
  development: 1,
  dev: 1,
  staging: 2,
  stage: 2,
  production: 3,
  prod: 3,
};

const KNOWN_CLOUDS = new Set([
  'aws',
  'gcp',
  'azure',
  'onprem',
  'on-prem',
  'kubernetes',
  'k8s',
  'yotta',
  'tencent',
  'alibaba',
  'oci',
  'oracle',
  'ibm',
  'digitalocean',
  'linode',
  'hetzner',
  'openshift',
  'confluent-cloud',
  'redis-enterprise',
]);

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  avatar: string;
  description?: string;
  clouds: string[];
  /** Env slugs discovered under this project */
  environments: string[];
  unitCount: number;
  kind: 'multi-cloud' | 'single-cloud';
}

export type EnvironmentKind = 'canonical' | 'ephemeral';

export interface EnvironmentDto {
  id: string;
  name: string;
  slug: string;
  order: number;
  kind: EnvironmentKind;
  isProduction: boolean;
  approvalRequired: boolean;
  baseEnv?: string;
  ttl?: string;
  expiresAt?: string;
  expired?: boolean;
  unitCount: number;
  /** Project slugs that contain this env (auto) */
  projects?: string[];
  createdAt: string;
  updatedAt: string;
}

interface CloneManifest {
  version: 1;
  kind: 'grid-env-clone';
  baseEnv: string;
  slug: string;
  sourcePath: string;
  createdAt: string;
  expiresAt: string;
  ttl: string;
}

function avatarFromName(name: string): string {
  const parts = name.replace(/[-_]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 1) || 'P').toUpperCase();
}

function titleCase(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Soft label for sorting / hints only — discovery itself is folder-based. */
function looksLikeEnv(name: string): boolean {
  if (ENV_ORDER[name] != null) return true;
  return /^(dev|development|staging|stage|prod|production|qa|test|sandbox|preview)([-_].+)?$/i.test(
    name
  );
}

function looksLikeCloud(name: string): boolean {
  return KNOWN_CLOUDS.has(name.toLowerCase());
}

/**
 * Cloud provider directory under projects/<slug>/.
 * Known cloud names always qualify. Other names qualify when they contain
 * at least one environment subdirectory (common name or any folder with units).
 */
async function isCloudDir(abs: string, name: string): Promise<boolean> {
  if (looksLikeCloud(name)) return true;
  if (looksLikeEnv(name) || SKIP_DIRS.has(name) || name.startsWith('.')) return false;
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (looksLikeEnv(e.name)) return true;
      if ((await countUnitsUnder(path.join(abs, e.name))) > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Project roots live only under projects/<slug>/…
 * (e.g. grid-config/projects/demo-app/aws/…).
 */
async function listProjectRoots(root: string): Promise<Array<{ slug: string; abs: string }>> {
  const out: Array<{ slug: string; abs: string }> = [];
  const projectsDir = path.join(root, 'projects');
  if (!(await fs.pathExists(projectsDir))) return out;

  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    out.push({ slug: ent.name, abs: path.join(projectsDir, ent.name) });
  }
  return out;
}

/** Fast path: under projects/… trust *.json except known non-intent names. */
function looksLikeIntentFilename(name: string): boolean {
  if (!name.endsWith('.json') || name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  return (
    lower !== 'project.json' &&
    lower !== 'package.json' &&
    lower !== 'package-lock.json' &&
    lower !== 'tsconfig.json' &&
    lower !== 'catalog_index.json' &&
    lower !== '.grid-clone.json'
  );
}

async function countUnitsUnder(dir: string): Promise<number> {
  if (!(await fs.pathExists(dir))) return 0;
  let n = 0;
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await walk(abs);
      } else if (ent.isFile() && looksLikeIntentFilename(ent.name)) {
        n += 1;
      }
    }
  };
  await walk(dir);
  return n;
}

type DiscoveredUnit = { project: string; cloud: string; env: string; abs: string; gitPath: string };

/** How long a directory walk stays reusable for /projects and /environments. */
const DISCOVERY_TTL_MS = 30_000;

let discoveryCache: { root: string; at: number; units: DiscoveredUnit[] } | null = null;
let discoveryInFlight: Promise<DiscoveredUnit[]> | null = null;

/** Drop the discovery cache (call after GitOps or config-root sync). */
export function invalidateConfigDiscoveryCache(): void {
  discoveryCache = null;
}

/**
 * Walk GRID_CONFIG_ROOT and discover intent JSON units.
 * Layout: projects/<project>/{cloud}/{env}/…/*.json
 *
 * Uses path + filename heuristics (no per-file JSON parse).
 * Results are cached briefly so repeated console requests share one walk.
 */
async function discoverUnits(root: string): Promise<DiscoveredUnit[]> {
  const now = Date.now();
  if (
    discoveryCache &&
    discoveryCache.root === root &&
    now - discoveryCache.at < DISCOVERY_TTL_MS
  ) {
    return discoveryCache.units;
  }
  if (discoveryInFlight) return discoveryInFlight;

  discoveryInFlight = discoverUnitsUncached(root)
    .then((units) => {
      discoveryCache = { root, at: Date.now(), units };
      return units;
    })
    .finally(() => {
      discoveryInFlight = null;
    });

  return discoveryInFlight;
}

async function discoverUnitsUncached(root: string): Promise<DiscoveredUnit[]> {
  const found: DiscoveredUnit[] = [];
  if (!(await fs.pathExists(root))) return found;

  const pushFromCloudEnv = async (project: string, cloudRoot: string, cloud: string) => {
    let envEntries;
    try {
      envEntries = await fs.readdir(cloudRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const envEnt of envEntries) {
      // Every non-skip directory under a cloud is an environment (folder-based).
      if (!envEnt.isDirectory() || SKIP_DIRS.has(envEnt.name) || envEnt.name.startsWith('.')) {
        continue;
      }
      const envDir = path.join(cloudRoot, envEnt.name);
      const walk = async (d: string) => {
        const entries = await fs.readdir(d, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.name.startsWith('.')) continue;
          const abs = path.join(d, ent.name);
          if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue;
            await walk(abs);
          } else if (ent.isFile() && looksLikeIntentFilename(ent.name)) {
            const gitPath = path.relative(root, abs).split(path.sep).join('/');
            found.push({ project, cloud, env: envEnt.name, abs, gitPath });
          }
        }
      };
      await walk(envDir);
    }
  };

  for (const p of await listProjectRoots(root)) {
    const top = await fs.readdir(p.abs, { withFileTypes: true });
    for (const cloudEnt of top) {
      if (!cloudEnt.isDirectory() || SKIP_DIRS.has(cloudEnt.name) || cloudEnt.name.startsWith('.')) {
        continue;
      }
      const cloudAbs = path.join(p.abs, cloudEnt.name);
      if (!(await isCloudDir(cloudAbs, cloudEnt.name))) continue;
      await pushFromCloudEnv(p.slug, cloudAbs, cloudEnt.name);
    }
  }

  return found;
}

async function readProjectMeta(
  projectRoot: string,
  fallbackSlug: string
): Promise<{ name: string; description?: string; slug: string }> {
  const metaPath = path.join(projectRoot, '.grid', 'project.json');
  if (await fs.pathExists(metaPath)) {
    try {
      const meta = (await fs.readJSON(metaPath)) as {
        name?: string;
        description?: string;
        slug?: string;
      };
      return {
        name: meta.name || titleCase(fallbackSlug),
        description: meta.description,
        slug: meta.slug || fallbackSlug,
      };
    } catch {
      /* fall through */
    }
  }
  return { name: titleCase(fallbackSlug), slug: fallbackSlug };
}

export async function listProjectsFromConfig(): Promise<ProjectDto[]> {
  const root = config.configRoot;
  const units = await discoverUnits(root);
  const byProject = new Map<string, DiscoveredUnit[]>();
  for (const u of units) {
    const list = byProject.get(u.project) || [];
    list.push(u);
    byProject.set(u.project, list);
  }

  const projectRoots = await listProjectRoots(root);
  const rootBySlug = new Map(projectRoots.map((p) => [p.slug, p.abs]));
  for (const p of projectRoots) {
    if (!byProject.has(p.slug)) byProject.set(p.slug, []);
  }

  const out: ProjectDto[] = [];
  for (const [slug, list] of byProject.entries()) {
    const projectRoot = rootBySlug.get(slug) || path.join(root, 'projects', slug);
    const meta = await readProjectMeta(projectRoot, slug);
    const clouds = [...new Set(list.map((u) => u.cloud))].sort();
    const environments = [...new Set(list.map((u) => u.env))].sort(
      (a, b) => (ENV_ORDER[a] ?? 50) - (ENV_ORDER[b] ?? 50) || a.localeCompare(b)
    );
    out.push({
      id: `project-${meta.slug}`,
      name: meta.name,
      slug: meta.slug,
      avatar: avatarFromName(meta.name),
      description: meta.description,
      clouds,
      environments,
      unitCount: list.length,
      kind: clouds.length > 1 ? 'multi-cloud' : 'single-cloud',
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Environments auto-detected from discovered units (+ ephemeral clones).
 * Optional projectSlug scopes unit counts / membership.
 */
export async function listEnvironmentsFromConfig(projectSlug?: string): Promise<EnvironmentDto[]> {
  const root = config.configRoot;
  const now = new Date();
  const nowIso = now.toISOString();
  const units = await discoverUnits(root);

  const filtered = projectSlug ? units.filter((u) => u.project === projectSlug) : units;

  const byEnv = new Map<string, { count: number; projects: Set<string> }>();
  for (const u of filtered) {
    const cur = byEnv.get(u.env) || { count: 0, projects: new Set<string>() };
    cur.count += 1;
    cur.projects.add(u.project);
    byEnv.set(u.env, cur);
  }

  const out: EnvironmentDto[] = [];
  const envNames = [...byEnv.keys()].sort(
    (a, b) => (ENV_ORDER[a] ?? 50) - (ENV_ORDER[b] ?? 50) || a.localeCompare(b)
  );

  const policies = await listApprovalPolicies();
  const policyBySlug = new Map(policies.map((p) => [p.slug.toLowerCase(), p]));

  for (const [i, slug] of envNames.entries()) {
    const info = byEnv.get(slug)!;
    const isProd = /prod/i.test(slug);
    const policy = policyBySlug.get(slug.toLowerCase());
    out.push({
      id: projectSlug ? `env-${projectSlug}-${slug}` : `env-${slug}`,
      name: titleCase(slug),
      slug,
      order: ENV_ORDER[slug] ?? 10 + i,
      kind: 'canonical',
      isProduction: isProd,
      approvalRequired: policy
        ? policy.approvalRequired
        : defaultApprovalRequired(slug),
      unitCount: info.count,
      projects: [...info.projects],
      createdAt: nowIso,
      updatedAt: policy?.updatedAt || nowIso,
    });
  }

  // Ephemeral clones at config root
  const ephemeralRoot = path.join(root, '.ephemeral');
  if (await fs.pathExists(ephemeralRoot)) {
    const dirs = await fs.readdir(ephemeralRoot, { withFileTypes: true });
    let order = 100;
    for (const ent of dirs) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const cloneRoot = path.join(ephemeralRoot, ent.name);
      const manifestPath = path.join(cloneRoot, '.grid-clone.json');
      if (!(await fs.pathExists(manifestPath))) continue;
      let manifest: CloneManifest;
      try {
        manifest = (await fs.readJSON(manifestPath)) as CloneManifest;
      } catch {
        continue;
      }
      if (manifest.kind !== 'grid-env-clone') continue;
      const expired = now.getTime() > Date.parse(manifest.expiresAt);
      const unitCount = await countUnitsUnder(cloneRoot);
      const label = `${manifest.baseEnv}/${manifest.slug}`;
      const baseSlug = (manifest.baseEnv || '').toLowerCase();
      const policy = policyBySlug.get(ent.name.toLowerCase()) || policyBySlug.get(baseSlug);
      const approvalRequired = policy
        ? policy.approvalRequired
        : defaultApprovalRequired(manifest.baseEnv || ent.name);
      out.push({
        id: `env-ephemeral-${ent.name}`,
        name: expired ? `${label} (expired)` : label,
        slug: ent.name,
        order: order++,
        kind: 'ephemeral',
        isProduction: /prod/i.test(manifest.baseEnv || ''),
        approvalRequired,
        baseEnv: manifest.baseEnv,
        ttl: manifest.ttl,
        expiresAt: manifest.expiresAt,
        expired,
        unitCount,
        createdAt: manifest.createdAt || nowIso,
        updatedAt: policy?.updatedAt || nowIso,
      });
    }
  }

  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Resolve project slug from a gitPath (`projects/<slug>/…`). */
export function projectSlugFromGitPath(gitPath?: string): string {
  if (!gitPath) return 'demo-app';
  const parts = gitPath.replace(/\\/g, '/').split('/');
  if (parts[0] === 'projects' && parts[1]) return parts[1];
  return 'demo-app';
}
