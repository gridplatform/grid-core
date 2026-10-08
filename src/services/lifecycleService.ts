import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { cliChildEnv, config } from '../config';
import type { Deployment, Infrastructure, LifecycleMode } from '../types/api';
import {
  appendDeploymentLog,
  getDeployment,
  saveDeployment,
  saveInfrastructure,
} from '../store/memoryStore';
import { killTrackedProcesses, trackChildProcess } from './processRegistry';

/** Skip mutating a deployment that was cancelled (superseded by a newer run). */
async function stillActive(deployment: Deployment): Promise<boolean> {
  const latest = await getDeployment(deployment.id);
  return !!latest && latest.status !== 'cancelled';
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => Promise<void>,
  trackKey?: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: cliChildEnv(),
      shell: false,
    });
    if (trackKey) trackChildProcess(trackKey, child);

    const handle = async (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          await onLine(line);
        }
      }
    };

    child.stdout.on('data', (c) => {
      void handle(c);
    });
    child.stderr.on('data', (c) => {
      void handle(c);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function captureCommand(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => Promise<void>,
  trackKey?: string
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: cliChildEnv(),
      shell: false,
    });
    if (trackKey) trackChildProcess(trackKey, child);
    let stdout = '';

    const handleOut = async (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          await onLine(line);
        }
      }
    };
    const handleErr = async (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          await onLine(line);
        }
      }
    };

    child.stdout.on('data', (c) => {
      void handleOut(c);
    });
    child.stderr.on('data', (c) => {
      void handleErr(c);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function generateTerraform(
  configPath: string,
  generatedDir: string,
  log: (line: string) => Promise<void>,
  opts?: { configDir?: string; writeArchive?: boolean; trackKey?: string }
): Promise<number> {
  const cliEntryJs = path.join(config.cliRoot, 'dist', 'index.js');
  const cliEntryTs = path.join(config.cliRoot, 'src', 'index.ts');
  const useCompiled = await fs.pathExists(cliEntryJs);

  // Archive mode: omit --output; CLI writes under configRoot/archive/
  const args = ['generate', '--config', configPath, '--format', 'terraform'];
  if (opts?.writeArchive && opts.configDir) {
    args.push('--config-dir', opts.configDir);
  } else {
    args.push('--output', generatedDir);
    if (opts?.configDir) args.push('--config-dir', opts.configDir);
  }

  if (useCompiled) {
    return runCommand(
      process.execPath,
      [cliEntryJs, ...args],
      config.cliRoot,
      log,
      opts?.trackKey
    );
  }

  return runCommand(
    path.join(config.cliRoot, 'node_modules', '.bin', 'tsx'),
    [cliEntryTs, ...args],
    config.cliRoot,
    log,
    opts?.trackKey
  );
}

function slugSegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Derive desired-state relative path (without .json) from infra metadata so
 * console-created units also land under archive/ next to Git units.
 */
function archiveUnitRelFromInfra(infra: Infrastructure): string | null {
  const cfg = infra.configJson || {};
  const meta = (cfg.metadata || {}) as { name?: string; environment?: string };
  const project = slugSegment(infra.project || 'default');
  const provider = slugSegment(String(infra.provider || cfg.provider || 'aws'));
  const environment = slugSegment(
    infra.environment || meta.environment || 'development'
  );
  const name = slugSegment(meta.name || infra.name || '');
  const resources = cfg.resources as Array<{ type?: string }> | undefined;
  const type = slugSegment(resources?.[0]?.type || 'unit');
  if (!project || !provider || !environment || !type || !name) return null;
  return `projects/${project}/${provider}/${environment}/${type}/${name}`;
}

/**
 * Resolve Terraform dirs: prefer archive/ (Git path or derived path);
 * fall back to workDir/<id>/generated only when metadata is incomplete.
 */
function resolveTerraformDirs(infra: Infrastructure): {
  configPath: string;
  terraformDir: string;
  writeArchive: boolean;
  configDir?: string;
  /** When set, persist onto infra so later runs stay on the same path. */
  derivedGitPath?: string;
} {
  const gitPath = infra.gitPath?.replace(/\\/g, '/').replace(/^\.\//, '');
  if (gitPath && !gitPath.startsWith('archive/') && gitPath.endsWith('.json')) {
    const configPath = path.join(config.configRoot, gitPath);
    const unitRel = gitPath.replace(/\.json$/i, '');
    const terraformDir = path.join(config.configRoot, 'archive', unitRel);
    return {
      configPath,
      terraformDir,
      writeArchive: true,
      configDir: config.configRoot,
    };
  }

  const unitRel = archiveUnitRelFromInfra(infra);
  if (unitRel) {
    const derivedGitPath = `${unitRel}.json`;
    return {
      configPath: path.join(config.configRoot, derivedGitPath),
      terraformDir: path.join(config.configRoot, 'archive', unitRel),
      writeArchive: true,
      configDir: config.configRoot,
      derivedGitPath,
    };
  }

  const workspace = path.join(config.workDir, infra.id);
  return {
    configPath: path.join(workspace, 'grid.json'),
    terraformDir: path.join(workspace, 'generated'),
    writeArchive: false,
  };
}

async function failDeployment(
  deployment: Deployment,
  infra: Infrastructure,
  message: string
): Promise<void> {
  if (!(await stillActive(deployment))) {
    await appendDeploymentLog(deployment.id, `${message} (ignored — run already cancelled)`);
    return;
  }
  deployment.status = 'failed';
  deployment.progress = 100;
  deployment.completedAt = new Date().toISOString();
  infra.status = 'error';
  infra.updatedAt = new Date().toISOString();
  await appendDeploymentLog(deployment.id, message);
  await saveDeployment(deployment);
  await saveInfrastructure(infra);
}

/**
 * Regenerate instance Terraform from configJson, then plan/apply/destroy.
 * Prefer GRID_CONFIG_ROOT/archive/ (Git path or derived path); workDir is fallback.
 */
export async function runLifecycle(
  infra: Infrastructure,
  deployment: Deployment,
  mode: LifecycleMode
): Promise<void> {
  const resolved = resolveTerraformDirs(infra);
  await fs.ensureDir(path.dirname(resolved.configPath));
  await fs.writeJSON(resolved.configPath, infra.configJson, { spaces: 2 });
  await fs.ensureDir(resolved.terraformDir);

  if (resolved.derivedGitPath && !infra.gitPath) {
    infra.gitPath = resolved.derivedGitPath;
    infra.updatedAt = new Date().toISOString();
    await saveInfrastructure(infra);
  }

  const generatedDir = resolved.terraformDir;

  const log = async (line: string) => {
    await appendDeploymentLog(deployment.id, line);
  };

  await log(
    resolved.writeArchive
      ? `[grid] Terraform output (archive): ${generatedDir}`
      : `[grid] Terraform output (workspace scratch): ${generatedDir}`
  );

  const checkpoint = async (mutate: () => void): Promise<boolean> => {
    if (!(await stillActive(deployment))) {
      await log('[grid] aborting — this run was cancelled');
      return false;
    }
    mutate();
    await saveDeployment(deployment);
    return true;
  };

  deployment.mode = mode;
  if (
    !(await checkpoint(() => {
      deployment.status = mode === 'plan' ? 'planning' : 'running';
      deployment.progress = 10;
    }))
  ) {
    return;
  }

  await log(
    `[grid] terraformDir=${generatedDir} mode=${mode} archive=${resolved.writeArchive}`
  );

  const trackKey = deployment.id;

  // Regenerate instance TF from current JSON before plan/apply/destroy.
  await log('[grid] regenerating instance Terraform from JSON (module bank unchanged)...');
  const genCode = await generateTerraform(resolved.configPath, generatedDir, log, {
    configDir: resolved.configDir,
    writeArchive: resolved.writeArchive,
    trackKey,
  });
  if (genCode !== 0) {
    await failDeployment(deployment, infra, '[grid] generate failed');
    return;
  }

  if (
    !(await checkpoint(() => {
      deployment.progress = 40;
    }))
  ) {
    return;
  }
  await log('[terraform] init');

  const initCode = await runCommand(
    config.terraformBin,
    ['init', '-input=false'],
    generatedDir,
    log,
    trackKey
  );
  if (initCode !== 0) {
    await failDeployment(deployment, infra, '[terraform] init failed');
    return;
  }

  if (
    !(await checkpoint(() => {
      deployment.progress = 60;
    }))
  ) {
    return;
  }

  if (mode === 'plan') {
    await log('[terraform] plan');
    const planResult = await captureCommand(
      config.terraformBin,
      ['plan', '-input=false', '-no-color', '-out=tfplan'],
      generatedDir,
      log,
      trackKey
    );

    if (planResult.code !== 0) {
      await failDeployment(deployment, infra, '[terraform] plan failed');
      return;
    }

    deployment.planSummary = planResult.stdout.slice(0, 50_000);

    // Best-effort plan JSON summary for UI
    const show = await captureCommand(
      config.terraformBin,
      ['show', '-json', 'tfplan'],
      generatedDir,
      async () => undefined,
      trackKey
    );
    if (show.code === 0 && show.stdout.trim()) {
      try {
        const parsed = JSON.parse(show.stdout) as {
          resource_changes?: Array<{ change?: { actions?: string[] } }>;
        };
        const actions = { create: 0, update: 0, delete: 0, noop: 0 };
        for (const rc of parsed.resource_changes || []) {
          const a = rc.change?.actions || [];
          if (a.includes('create') && a.includes('delete')) actions.update += 1;
          else if (a.includes('create')) actions.create += 1;
          else if (a.includes('update')) actions.update += 1;
          else if (a.includes('delete')) actions.delete += 1;
          else actions.noop += 1;
        }
        deployment.planSummary =
          `Plan: ${actions.create} to add, ${actions.update} to change, ${actions.delete} to destroy.\n\n` +
          (deployment.planSummary || '');
      } catch {
        // keep text plan
      }
    }

    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.updatedAt = new Date().toISOString();

    if (!(await stillActive(deployment))) {
      await log('[grid] plan finished but run was cancelled — not saving');
      return;
    }

    deployment.status = 'success';
    await log('[grid] plan succeeded');
    await saveDeployment(deployment);
    await saveInfrastructure(infra);
    return;
  }

  if (mode === 'destroy') {
    await log('[terraform] destroy -auto-approve');
    const destroyCode = await runCommand(
      config.terraformBin,
      ['destroy', '-input=false', '-no-color', '-auto-approve'],
      generatedDir,
      log,
      trackKey
    );

    if (!(await stillActive(deployment))) {
      await log('[grid] destroy finished but run was cancelled — not saving');
      return;
    }

    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.updatedAt = new Date().toISOString();

    if (destroyCode === 0) {
      deployment.status = 'success';
      infra.status = 'destroyed';
      await log('[grid] destroy succeeded');
      await saveDeployment(deployment);
      await saveInfrastructure(infra);

      // If desired-state JSON is gone, drop the store row so it does not linger as a ghost.
      if (infra.gitPath) {
        const abs = path.join(config.configRoot, infra.gitPath);
        if (!(await fs.pathExists(abs))) {
          const { deleteInfrastructure } = await import('../store/memoryStore');
          await deleteInfrastructure(infra.id);
          await log('[grid] removed store entry (no longer in config)');
        }
      } else {
        const { deleteInfrastructure } = await import('../store/memoryStore');
        await deleteInfrastructure(infra.id);
        await log('[grid] removed orphan store entry');
      }
      return;
    }

    deployment.status = 'failed';
    infra.status = 'error';
    await log('[grid] destroy failed');
    await saveDeployment(deployment);
    await saveInfrastructure(infra);
    return;
  }

  // apply: refresh tfplan then apply it
  await log('[terraform] plan');
  const planCode = await runCommand(
    config.terraformBin,
    ['plan', '-input=false', '-no-color', '-out=tfplan'],
    generatedDir,
    log,
    trackKey
  );
  if (planCode !== 0) {
    await failDeployment(deployment, infra, '[terraform] plan failed');
    return;
  }

  if (
    !(await checkpoint(() => {
      deployment.progress = 75;
    }))
  ) {
    return;
  }

  await log('[terraform] apply (from tfplan)');
  const applyCode = await runCommand(
    config.terraformBin,
    ['apply', '-input=false', '-no-color', 'tfplan'],
    generatedDir,
    log,
    trackKey
  );

  if (!(await stillActive(deployment))) {
    await log('[grid] apply finished but run was cancelled — not saving');
    return;
  }

  deployment.progress = 100;
  deployment.completedAt = new Date().toISOString();
  infra.updatedAt = new Date().toISOString();

  if (applyCode === 0) {
    deployment.status = 'success';
    infra.status = 'running';
    const { markApplied } = await import('./driftService');
    await markApplied(infra);
    await log('[grid] apply succeeded');
  } else {
    deployment.status = 'failed';
    infra.status = 'error';
    await log('[grid] apply failed');
  }

  await saveDeployment(deployment);
  await saveInfrastructure(infra);
}

/** Mark deployment cancelled and SIGTERM any tracked terraform/CLI children. */
export function abortDeploymentProcesses(deploymentId: string): number {
  return killTrackedProcesses(deploymentId);
}

/**
 * Fail-safe cleanup after killing an apply/destroy mid-flight:
 * run terraform destroy if local state has resources, then remove local state files.
 * Never deletes state without attempting destroy first (avoids orphaned cloud resources).
 */
export async function cleanupPartialTerraform(
  infra: Infrastructure,
  log: (line: string) => Promise<void>
): Promise<{ cleaned: boolean; message: string }> {
  const resolved = resolveTerraformDirs(infra);
  const dir = resolved.terraformDir;
  if (!(await fs.pathExists(dir))) {
    return { cleaned: false, message: 'No terraform workspace on disk' };
  }

  const statePath = path.join(dir, 'terraform.tfstate');
  const hasLocalState = await fs.pathExists(statePath);
  const hasBackend = await fs.pathExists(path.join(dir, '.terraform'));

  if (!hasLocalState && !hasBackend) {
    await log('[grid] cleanup: no terraform state found — nothing to destroy');
    return { cleaned: true, message: 'No state present' };
  }

  const cleanupKey = `cleanup:${infra.id}:${Date.now()}`;
  try {
    await log('[grid] cleanup: terraform init (before destroy)');
    const initCode = await runCommand(
      config.terraformBin,
      ['init', '-input=false', '-no-color'],
      dir,
      log,
      cleanupKey
    );
    if (initCode !== 0) {
      await log('[grid] cleanup: init failed — leaving state intact for manual recovery');
      return { cleaned: false, message: 'terraform init failed during cleanup' };
    }

    await log('[grid] cleanup: terraform destroy -auto-approve (roll back partial apply)');
    const destroyCode = await runCommand(
      config.terraformBin,
      ['destroy', '-input=false', '-no-color', '-auto-approve'],
      dir,
      log,
      cleanupKey
    );

    if (destroyCode !== 0) {
      await log(
        '[grid] cleanup: destroy failed — state kept so you can retry destroy manually'
      );
      return { cleaned: false, message: 'terraform destroy failed during cleanup' };
    }

    // Safe to clear local state artifacts after successful destroy.
    for (const name of [
      'terraform.tfstate',
      'terraform.tfstate.backup',
      'tfplan',
      '.terraform.lock.hcl',
    ]) {
      await fs.remove(path.join(dir, name)).catch(() => undefined);
    }
    await fs.remove(path.join(dir, '.terraform')).catch(() => undefined);
    await log('[grid] cleanup: destroy succeeded; local state artifacts removed');

    infra.status = 'pending';
    infra.updatedAt = new Date().toISOString();
    await saveInfrastructure(infra);

    return { cleaned: true, message: 'Destroyed cloud resources and cleared local state' };
  } finally {
    killTrackedProcesses(cleanupKey);
  }
}

/** @deprecated Use runLifecycle(..., 'apply') */
export async function runInfrastructureDeploy(
  infra: Infrastructure,
  deployment: Deployment
): Promise<void> {
  return runLifecycle(infra, deployment, 'apply');
}
