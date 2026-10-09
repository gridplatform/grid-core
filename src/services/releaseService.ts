import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { cliChildEnv, config } from '../config';
import type { Release, ReleaseMode } from '../types/api';
import {
  appendReleaseLog,
  findActiveRelease,
  findNextQueued,
  getRelease,
  saveRelease,
} from './releaseStore';
import {
  createDeployment,
  getDeployment,
  getInfrastructure,
  saveDeployment,
  saveInfrastructure,
} from '../store/memoryStore';
import {
  abortDeploymentProcesses,
  cleanupPartialTerraform,
  runLifecycle,
} from './lifecycleService';
import { killTrackedProcesses, releaseRunKey, trackChildProcess } from './processRegistry';
import { getApprovalRequired, modeRequiresApprovalGate } from './approvalPolicyStore';
import {
  assertDomainAccess,
  releaseDomainForMode,
  requiredLevelForReleaseMode,
  resolveAccessByEmail,
} from './accessService';

const ALLOWED_GRID_SUBCOMMANDS = new Set([
  'status',
  'deploy',
  'destroy',
  'plan',
  'generate',
  'validate',
  'prune',
  'init',
  'catalog',
  'version',
  'help',
]);

/**
 * Parse a custom "grid …" command into argv for the CLI entrypoint.
 * Rejects shell metacharacters / piping.
 */
export function parseGridCliCommand(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Custom command is empty');
  if (/[;|&`$()<>]/.test(trimmed)) {
    throw new Error('Custom command cannot contain shell metacharacters');
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  let args = parts;
  if (parts[0] === 'grid' || parts[0] === 'gridcli') {
    args = parts.slice(1);
  }
  if (args.length === 0) throw new Error('Provide a grid subcommand (e.g. status --config-dir .)');

  const sub = args[0].replace(/^-*/, '');
  if (!ALLOWED_GRID_SUBCOMMANDS.has(args[0]) && !ALLOWED_GRID_SUBCOMMANDS.has(sub)) {
    throw new Error(
      `Subcommand "${args[0]}" is not allowed. Allowed: ${[...ALLOWED_GRID_SUBCOMMANDS].join(', ')}`
    );
  }
  return args;
}

async function runGridCli(
  args: string[],
  onLine: (line: string) => Promise<void>,
  trackKey?: string
): Promise<number> {
  const cliEntryJs = path.join(config.cliRoot, 'dist', 'index.js');
  const cliEntryTs = path.join(config.cliRoot, 'src', 'index.ts');
  const useCompiled = await fs.pathExists(cliEntryJs);

  const command = useCompiled
    ? process.execPath
    : path.join(config.cliRoot, 'node_modules', '.bin', 'tsx');
  const fullArgs = useCompiled ? [cliEntryJs, ...args] : [cliEntryTs, ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, {
      cwd: config.cliRoot,
      env: cliChildEnv(),
      shell: false,
    });
    if (trackKey) trackChildProcess(trackKey, child);
    const handle = async (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) await onLine(line);
      }
    };
    child.stdout?.on('data', (c) => void handle(c));
    child.stderr?.on('data', (c) => void handle(c));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function finishRelease(release: Release, ok: boolean, message: string): Promise<void> {
  const current = await getRelease(release.id);
  if (current?.status === 'cancelled') {
    void processReleaseQueue();
    return;
  }
  release.status = ok ? 'success' : 'failed';
  release.message = message;
  release.completedAt = new Date().toISOString();
  if (ok) release.deployedAt = release.completedAt;
  await saveRelease(release);
  await appendReleaseLog(release.id, `[grid] ${message}`);
  try {
    const { recordAudit } = await import('./auditStore');
    await recordAudit({
      action: 'release.finish',
      actor: release.createdBy,
      resourceType: 'release',
      resourceId: release.id,
      resourceName: release.name,
      summary: `${release.mode} release ${ok ? 'succeeded' : 'failed'}: ${release.name}`,
      details: {
        mode: release.mode,
        environment: release.environment,
        infrastructureId: release.infrastructureId,
        message,
      },
      outcome: ok ? 'success' : 'failure',
    });
  } catch {
    /* audit must never block release completion */
  }
  void processReleaseQueue();
}

async function executeRelease(releaseId: string): Promise<void> {
  const release = await getRelease(releaseId);
  if (!release) return;
  if (release.status === 'cancelled') return;

  if (release.status !== 'deploying') {
    release.status = 'deploying';
    release.deployedAt = new Date().toISOString();
    await saveRelease(release);
  }
  await appendReleaseLog(release.id, `[grid] starting ${release.mode} release: ${release.name}`);

  try {
    if (release.mode === 'custom') {
      const args = parseGridCliCommand(release.customCommand || '');
      await appendReleaseLog(release.id, `[grid] $ grid ${args.join(' ')}`);
      const code = await runGridCli(
        args,
        (line) => appendReleaseLog(release.id, line),
        releaseRunKey(release.id)
      );
      const latest = (await getRelease(release.id))!;
      if (latest.status === 'cancelled') return;
      await finishRelease(
        latest,
        code === 0,
        code === 0 ? 'Custom CLI release succeeded' : `Custom CLI exited with code ${code}`
      );
      return;
    }

    if (!release.infrastructureId) {
      await finishRelease(release, false, 'No infrastructure selected for this release');
      return;
    }

    const infra = await getInfrastructure(release.infrastructureId);
    if (!infra) {
      await finishRelease(release, false, 'Infrastructure not found');
      return;
    }
    if (infra.status === 'destroyed' && !infra.gitPath) {
      await finishRelease(release, false, 'Infrastructure was destroyed and has no config path');
      return;
    }
    if (infra.status === 'destroyed' && infra.gitPath) {
      infra.status = 'pending';
      infra.lastAppliedHash = undefined;
      infra.updatedAt = new Date().toISOString();
      await saveInfrastructure(infra);
      await appendReleaseLog(
        release.id,
        '[grid] legacy destroyed status → pending (config-backed unit)'
      );
    }

    if (release.mode !== 'plan' && release.mode !== 'apply' && release.mode !== 'destroy') {
      await finishRelease(release, false, `Unsupported release mode: ${release.mode}`);
      return;
    }

    const mode = release.mode;
    const deployment = await createDeployment(infra.id, release.createdBy, {
      name: release.name,
      engine: 'terraform',
      resourceType: release.mode,
      provider: infra.provider,
      environment: release.environment || infra.environment,
      mode,
    });

    release.deploymentId = deployment.id;
    await saveRelease(release);
    await appendReleaseLog(release.id, `[grid] linked deployment ${deployment.id}`);

    await runLifecycle(infra, deployment, mode);

    const latest = (await getRelease(release.id))!;
    if (latest.status === 'cancelled') return;
    const depDone = (await getDeployment(deployment.id)) || deployment;
    if (depDone.status === 'cancelled') return;
    const ok = depDone.status === 'success';
    await finishRelease(
      latest,
      ok,
      ok ? `${mode} release succeeded` : `${mode} release failed — see deployment logs`
    );
  } catch (err) {
    const latest = (await getRelease(release.id)) || release;
    if (latest.status === 'cancelled') return;
    await finishRelease(latest, false, err instanceof Error ? err.message : String(err));
  }
}

let queueLock: Promise<void> = Promise.resolve();

/** Start next queued release if nothing is deploying. */
export async function processReleaseQueue(): Promise<void> {
  queueLock = queueLock.then(async () => {
    const active = await findActiveRelease();
    if (active) return;
    const next = await findNextQueued();
    if (!next) return;
    next.status = 'deploying';
    next.deployedAt = new Date().toISOString();
    next.message = undefined;
    await saveRelease(next);
    void executeRelease(next.id);
  });
  await queueLock;
}

export type CreateReleaseInput = {
  name?: string;
  environment: string;
  mode: ReleaseMode;
  infrastructureId?: string;
  customCommand?: string;
  createdBy: string;
};

/**
 * Enqueue or start a release. At most one release is `deploying` at a time;
 * others sit in `queued` until the active one finishes.
 */
export async function enqueueRelease(input: CreateReleaseInput): Promise<Release> {
  if (input.mode === 'custom') {
    parseGridCliCommand(input.customCommand || '');
  } else if (!input.infrastructureId) {
    throw new Error('Select an infrastructure unit for plan/apply/destroy releases');
  }

  let infrastructureName: string | undefined;
  let projectSlug: string | undefined;
  if (input.infrastructureId) {
    const infra = await getInfrastructure(input.infrastructureId);
    if (!infra) throw new Error('Infrastructure not found');
    if (infra.status === 'destroyed' && !infra.gitPath) {
      throw new Error('Infrastructure was destroyed and has no config path');
    }
    infrastructureName = infra.name;
    projectSlug = infra.project;
  }

  const accessCtx = { project: projectSlug, environment: input.environment };
  const access = await resolveAccessByEmail(input.createdBy, accessCtx);
  if (!access) {
    const { AccessError } = await import('../lib/httpError');
    throw new AccessError('Unknown user — cannot create release');
  }

  const domain = releaseDomainForMode(input.mode);
  const need = requiredLevelForReleaseMode(input.mode);
  assertDomainAccess(access, domain, need, `${input.mode} release`, accessCtx);

  const envRequiresApproval =
    modeRequiresApprovalGate(input.mode) &&
    (await getApprovalRequired(input.environment));

  // Superadmin bypasses. Built-in global roles follow per-environment approval policy.
  // Custom-group write (env-scoped member access) always requires approval.
  const needsApproval =
    !access.canBypassApproval &&
    modeRequiresApprovalGate(input.mode) &&
    (access.customWriteAlwaysNeedsApproval || envRequiresApproval);

  const active = needsApproval ? undefined : await findActiveRelease();

  const { createRelease } = await import('./releaseStore');
  const release = await createRelease({
    name:
      input.name ||
      (input.mode === 'custom'
        ? 'Custom CLI release'
        : `${infrastructureName || 'infra'} (${input.mode})`),
    type: input.mode === 'custom' ? 'custom' : 'terraform',
    mode: input.mode,
    environment: input.environment,
    infrastructureId: input.infrastructureId,
    infrastructureName,
    customCommand: input.customCommand,
    status: needsApproval ? 'pending_approval' : 'queued',
    createdBy: input.createdBy,
  });

  if (needsApproval) {
    release.message = `Waiting for approval (${input.environment})`;
    await saveRelease(release);
  } else if (active) {
    release.message = `Queued behind “${active.name}” — only one release runs at a time`;
    await saveRelease(release);
  }

  if (!needsApproval) {
    void processReleaseQueue();
  }
  const saved = (await getRelease(release.id))!;
  try {
    const { recordAudit } = await import('./auditStore');
    await recordAudit({
      action: 'release.create',
      actor: input.createdBy,
      resourceType: 'release',
      resourceId: saved.id,
      resourceName: saved.name,
      summary: needsApproval
        ? `Created ${saved.mode} release pending approval: ${saved.name}`
        : `Created ${saved.mode} release: ${saved.name}`,
      details: {
        mode: saved.mode,
        environment: saved.environment,
        infrastructureId: saved.infrastructureId,
        status: saved.status,
        approvalRequired: needsApproval,
      },
    });
  } catch {
    /* ignore */
  }
  return saved;
}

export type ApprovalDecision = {
  id: string;
  releaseId: string;
  status: 'pending' | 'approved' | 'rejected';
  requiredRole: 'maintainer' | 'admin' | 'superadmin';
  requestedBy: string;
  requestedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  comment?: string;
};

function releaseToApproval(release: Release): ApprovalDecision {
  const status: ApprovalDecision['status'] =
    release.status === 'pending_approval'
      ? 'pending'
      : release.approvedBy
        ? 'approved'
        : release.status === 'cancelled' && release.message?.toLowerCase().includes('reject')
          ? 'rejected'
          : 'pending';
  return {
    id: release.id,
    releaseId: release.id,
    status,
    requiredRole: 'maintainer',
    requestedBy: release.createdBy,
    requestedAt: release.createdAt,
    reviewedBy: release.approvedBy,
    reviewedAt: release.approvedAt,
    comment: release.message,
  };
}

/** Pending human approvals (release id == approval id). */
export async function listPendingApprovals(): Promise<ApprovalDecision[]> {
  const { listReleases } = await import('./releaseStore');
  const items = await listReleases();
  return items
    .filter((r) => r.status === 'pending_approval')
    .map(releaseToApproval)
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
}

/** Approve a pending release → queued for execution. */
export async function approveRelease(
  releaseId: string,
  actor: string,
  comment?: string
): Promise<ApprovalDecision> {
  const release = await getRelease(releaseId);
  if (!release) throw new Error('Release not found');
  if (release.status !== 'pending_approval') {
    throw new Error(`Release is ${release.status}, not pending approval`);
  }
  if (release.createdBy.toLowerCase() === actor.toLowerCase()) {
    throw new Error('Requester cannot approve their own release');
  }

  release.status = 'queued';
  release.approvedBy = actor;
  release.approvedAt = new Date().toISOString();
  release.message = comment?.trim()
    ? `Approved by ${actor}: ${comment.trim()}`
    : `Approved by ${actor}`;
  await saveRelease(release);
  await appendReleaseLog(release.id, `[grid] approved by ${actor}`);

  try {
    const { recordAudit } = await import('./auditStore');
    await recordAudit({
      action: 'release.approve',
      actor,
      resourceType: 'release',
      resourceId: release.id,
      resourceName: release.name,
      summary: `Approved release: ${release.name}`,
      details: { environment: release.environment, mode: release.mode, comment },
    });
  } catch {
    /* ignore */
  }

  void processReleaseQueue();
  return releaseToApproval((await getRelease(release.id))!);
}

/** Reject a pending release. */
export async function rejectRelease(
  releaseId: string,
  actor: string,
  comment?: string
): Promise<ApprovalDecision> {
  const release = await getRelease(releaseId);
  if (!release) throw new Error('Release not found');
  if (release.status !== 'pending_approval') {
    throw new Error(`Release is ${release.status}, not pending approval`);
  }

  release.status = 'cancelled';
  release.completedAt = new Date().toISOString();
  release.message = comment?.trim()
    ? `Rejected by ${actor}: ${comment.trim()}`
    : `Rejected by ${actor}`;
  await saveRelease(release);
  await appendReleaseLog(release.id, `[grid] rejected by ${actor}`);

  try {
    const { recordAudit } = await import('./auditStore');
    await recordAudit({
      action: 'release.reject',
      actor,
      resourceType: 'release',
      resourceId: release.id,
      resourceName: release.name,
      summary: `Rejected release: ${release.name}`,
      details: { environment: release.environment, mode: release.mode, comment },
      outcome: 'denied',
    });
  } catch {
    /* ignore */
  }

  return releaseToApproval(release);
}

/**
 * Admin: cancel a queued release, or kill a deploying one.
 * For apply/destroy mid-flight, attempts terraform destroy cleanup before clearing local state.
 */
export async function cancelRelease(releaseId: string, actor: string): Promise<Release> {
  const release = await getRelease(releaseId);
  if (!release) throw new Error('Release not found');

  if (
    release.status === 'success' ||
    release.status === 'failed' ||
    release.status === 'cancelled' ||
    release.status === 'rolled_back'
  ) {
    throw new Error(`Release is already ${release.status}`);
  }

  if (
    release.status === 'queued' ||
    release.status === 'pending_approval' ||
    release.status === 'approved'
  ) {
    release.status = 'cancelled';
    release.message = `Cancelled by ${actor} (was ${release.status})`;
    release.completedAt = new Date().toISOString();
    await saveRelease(release);
    await appendReleaseLog(release.id, `[grid] cancelled by ${actor}`);
    await auditCancel(release, actor, 'queued');
    void processReleaseQueue();
    return (await getRelease(release.id))!;
  }

  await appendReleaseLog(release.id, `[grid] kill requested by ${actor}`);

  if (release.deploymentId) {
    const dep = await getDeployment(release.deploymentId);
    if (dep && (dep.status === 'pending' || dep.status === 'planning' || dep.status === 'running')) {
      dep.status = 'cancelled';
      dep.completedAt = new Date().toISOString();
      await saveDeployment(dep);
      await appendReleaseLog(release.id, `[grid] cancelled linked deployment ${dep.id}`);
    }
    const killed = abortDeploymentProcesses(release.deploymentId);
    await appendReleaseLog(release.id, `[grid] signalled ${killed} terraform/CLI process(es)`);
  }

  const customKilled = killTrackedProcesses(releaseRunKey(release.id));
  if (customKilled > 0) {
    await appendReleaseLog(release.id, `[grid] signalled ${customKilled} custom CLI process(es)`);
  }

  await new Promise((r) => setTimeout(r, 500));

  if ((release.mode === 'apply' || release.mode === 'destroy') && release.infrastructureId) {
    const infra = await getInfrastructure(release.infrastructureId);
    if (infra && infra.status !== 'destroyed') {
      await appendReleaseLog(
        release.id,
        '[grid] fail-safe cleanup: attempting terraform destroy for partial changes…'
      );
      const result = await cleanupPartialTerraform(infra, (line) =>
        appendReleaseLog(release.id, line)
      );
      await appendReleaseLog(release.id, `[grid] cleanup: ${result.message}`);
    }
  } else if (release.mode === 'plan') {
    await appendReleaseLog(release.id, '[grid] plan kill — no cloud cleanup required');
  }

  const latest = (await getRelease(release.id))!;
  latest.status = 'cancelled';
  latest.message = `Killed by ${actor}`;
  latest.completedAt = new Date().toISOString();
  await saveRelease(latest);
  await appendReleaseLog(latest.id, `[grid] release cancelled by ${actor}`);
  await auditCancel(latest, actor, 'deploying');
  void processReleaseQueue();
  return (await getRelease(latest.id))!;
}

async function auditCancel(
  release: Release,
  actor: string,
  from: 'queued' | 'deploying'
): Promise<void> {
  try {
    const { recordAudit } = await import('./auditStore');
    await recordAudit({
      action: 'release.cancel',
      actor,
      resourceType: 'release',
      resourceId: release.id,
      resourceName: release.name,
      summary:
        from === 'queued'
          ? `Cancelled queued release: ${release.name}`
          : `Killed running release: ${release.name}`,
      details: {
        mode: release.mode,
        environment: release.environment,
        infrastructureId: release.infrastructureId,
        deploymentId: release.deploymentId,
        from,
      },
    });
  } catch {
    /* ignore */
  }
}
