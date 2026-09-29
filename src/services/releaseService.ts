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
import { createDeployment, getInfrastructure } from '../store/memoryStore';
import { runLifecycle } from './lifecycleService';

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

async function runGridCli(args: string[], onLine: (line: string) => Promise<void>): Promise<number> {
  const cliEntryJs = path.join(config.cliRoot, 'dist', 'index.js');
  const cliEntryTs = path.join(config.cliRoot, 'src', 'index.ts');
  const useCompiled = await fs.pathExists(cliEntryJs);

  const command = useCompiled ? process.execPath : path.join(config.cliRoot, 'node_modules', '.bin', 'tsx');
  const fullArgs = useCompiled ? [cliEntryJs, ...args] : [cliEntryTs, ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, {
      cwd: config.cliRoot,
      env: cliChildEnv(),
      shell: false,
    });
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
  release.status = ok ? 'success' : 'failed';
  release.message = message;
  release.completedAt = new Date().toISOString();
  if (ok) release.deployedAt = release.completedAt;
  await saveRelease(release);
  await appendReleaseLog(release.id, `[grid] ${message}`);
  // Kick the queue
  void processReleaseQueue();
}

async function executeRelease(releaseId: string): Promise<void> {
  const release = await getRelease(releaseId);
  if (!release) return;

  // Status may already be deploying (set by processReleaseQueue).
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
      const code = await runGridCli(args, (line) => appendReleaseLog(release.id, line));
      const latest = (await getRelease(release.id))!;
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
    if (infra.status === 'destroyed') {
      await finishRelease(release, false, 'Infrastructure was destroyed');
      return;
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
    const { getDeployment } = await import('../store/memoryStore');
    const depDone = (await getDeployment(deployment.id)) || deployment;
    const ok = depDone.status === 'success';
    await finishRelease(
      latest,
      ok,
      ok ? `${mode} release succeeded` : `${mode} release failed — see deployment logs`
    );
  } catch (err) {
    const latest = (await getRelease(release.id)) || release;
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
    // Mark deploying atomically before starting work so concurrent callers skip.
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
  if (input.infrastructureId) {
    const infra = await getInfrastructure(input.infrastructureId);
    if (!infra) throw new Error('Infrastructure not found');
    if (infra.status === 'destroyed') throw new Error('Infrastructure was destroyed');
    infrastructureName = infra.name;
  }

  const active = await findActiveRelease();

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
    status: 'queued',
    createdBy: input.createdBy,
  });

  if (active) {
    release.message = `Queued behind “${active.name}” — only one release runs at a time`;
    await saveRelease(release);
  }

  void processReleaseQueue();
  return (await getRelease(release.id))!;
}
