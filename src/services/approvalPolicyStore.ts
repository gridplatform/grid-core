import path from 'path';
import fs from 'fs-extra';
import { config } from '../config';
import { readJsonSafe, writeJsonAtomic } from '../lib/jsonFile';

export interface EnvApprovalPolicy {
  /** Environment folder slug as discovered under projects/<app>/<cloud>/<env>/ */
  slug: string;
  /** When true, apply / destroy / custom releases wait for approval */
  approvalRequired: boolean;
  updatedAt: string;
  updatedBy?: string;
}

interface PolicyFile {
  version: 1;
  policies: EnvApprovalPolicy[];
}

const POLICY_FILE = () => path.join(config.dataDir, 'approval-policies.json');

let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readFile(): Promise<PolicyFile> {
  await fs.ensureDir(config.dataDir);
  const file = POLICY_FILE();
  const empty: PolicyFile = { version: 1, policies: [] };
  const data = await readJsonSafe<PolicyFile>(file, {
    label: 'approval-policies.json',
  });
  if (!data || !Array.isArray(data.policies)) {
    await writeJsonAtomic(file, empty);
    return empty;
  }
  return { version: 1, policies: data.policies };
}

async function writeFile(data: PolicyFile): Promise<void> {
  await fs.ensureDir(config.dataDir);
  await writeJsonAtomic(POLICY_FILE(), data);
}

/**
 * Default when the admin has not set a policy for this slug.
 * Admin overrides (including enabling approval on development) always win.
 */
export function defaultApprovalRequired(slug: string): boolean {
  const s = slug.toLowerCase();
  if (s === 'development' || s === 'dev') return false;
  if (/prod/.test(s) || /stag/.test(s)) return true;
  return false;
}

export async function listApprovalPolicies(): Promise<EnvApprovalPolicy[]> {
  return withLock(async () => (await readFile()).policies);
}

export async function getApprovalRequired(slug: string): Promise<boolean> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return false;
  return withLock(async () => {
    const file = await readFile();
    const hit = file.policies.find((p) => p.slug.toLowerCase() === normalized);
    if (hit) return hit.approvalRequired;
    return defaultApprovalRequired(normalized);
  });
}

export async function setApprovalRequired(
  slug: string,
  approvalRequired: boolean,
  updatedBy?: string
): Promise<EnvApprovalPolicy> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) throw new Error('Environment slug is required');

  return withLock(async () => {
    const file = await readFile();
    const now = new Date().toISOString();
    const idx = file.policies.findIndex((p) => p.slug.toLowerCase() === normalized);
    const next: EnvApprovalPolicy = {
      slug: normalized,
      approvalRequired,
      updatedAt: now,
      updatedBy,
    };
    if (idx >= 0) file.policies[idx] = next;
    else file.policies.push(next);
    await writeFile(file);
    return next;
  });
}

/** Modes that change cloud state and therefore may require approval. */
export function modeRequiresApprovalGate(mode: string): boolean {
  return mode === 'apply' || mode === 'destroy' || mode === 'custom';
}
