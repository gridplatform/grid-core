import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { cliChildEnv, config } from '../config';
import type { Deployment, Infrastructure, LifecycleMode } from '../types/api';
import {
  appendDeploymentLog,
  saveDeployment,
  saveInfrastructure,
} from '../store/memoryStore';

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => Promise<void>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: cliChildEnv(),
      shell: false,
    });

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
  onLine: (line: string) => Promise<void>
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: cliChildEnv(),
      shell: false,
    });
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
  opts?: { configDir?: string; writeArchive?: boolean }
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
    return runCommand(process.execPath, [cliEntryJs, ...args], config.cliRoot, log);
  }

  return runCommand(
    path.join(config.cliRoot, 'node_modules', '.bin', 'tsx'),
    [cliEntryTs, ...args],
    config.cliRoot,
    log
  );
}

/** Resolve Terraform dirs: gitPath → archive/; else workDir/<id>/generated. */
function resolveTerraformDirs(infra: Infrastructure): {
  configPath: string;
  terraformDir: string;
  writeArchive: boolean;
  configDir?: string;
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

  const workspace = path.join(config.workDir, infra.id);
  return {
    configPath: path.join(workspace, 'grid.json'),
    terraformDir: path.join(workspace, 'generated'),
    writeArchive: false,
  };
}

function failDeployment(
  deployment: Deployment,
  infra: Infrastructure,
  message: string
): Promise<void> {
  deployment.status = 'failed';
  deployment.progress = 100;
  deployment.completedAt = new Date().toISOString();
  infra.status = 'error';
  infra.updatedAt = new Date().toISOString();
  return Promise.all([
    appendDeploymentLog(deployment.id, message),
    saveDeployment(deployment),
    saveInfrastructure(infra),
  ]).then(() => undefined);
}

/**
 * Regenerate instance Terraform from configJson, then plan/apply/destroy.
 * gitPath units write under GRID_CONFIG_ROOT/archive/; else workDir.
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

  const generatedDir = resolved.terraformDir;

  const log = async (line: string) => {
    await appendDeploymentLog(deployment.id, line);
  };

  deployment.mode = mode;
  deployment.status = mode === 'plan' ? 'planning' : 'running';
  deployment.progress = 10;
  await saveDeployment(deployment);

  await log(
    `[grid] terraformDir=${generatedDir} mode=${mode} archive=${resolved.writeArchive}`
  );

  // Regenerate instance TF from current JSON before plan/apply/destroy.
  await log('[grid] regenerating instance Terraform from JSON (module bank unchanged)...');
  const genCode = await generateTerraform(resolved.configPath, generatedDir, log, {
    configDir: resolved.configDir,
    writeArchive: resolved.writeArchive,
  });
  if (genCode !== 0) {
    await failDeployment(deployment, infra, '[grid] generate failed');
    return;
  }

  deployment.progress = 40;
  await saveDeployment(deployment);
  await log('[terraform] init');

  const initCode = await runCommand(
    config.terraformBin,
    ['init', '-input=false'],
    generatedDir,
    log
  );
  if (initCode !== 0) {
    await failDeployment(deployment, infra, '[terraform] init failed');
    return;
  }

  deployment.progress = 60;
  await saveDeployment(deployment);

  if (mode === 'plan') {
    await log('[terraform] plan');
    const planResult = await captureCommand(
      config.terraformBin,
      ['plan', '-input=false', '-no-color', '-out=tfplan'],
      generatedDir,
      log
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
      async () => undefined
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

    deployment.status = 'success';
    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.updatedAt = new Date().toISOString();
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
      log
    );

    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.updatedAt = new Date().toISOString();

    if (destroyCode === 0) {
      deployment.status = 'success';
      infra.status = 'destroyed';
      await log('[grid] destroy succeeded');
    } else {
      deployment.status = 'failed';
      infra.status = 'error';
      await log('[grid] destroy failed');
    }

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
    log
  );
  if (planCode !== 0) {
    await failDeployment(deployment, infra, '[terraform] plan failed');
    return;
  }

  deployment.progress = 75;
  await saveDeployment(deployment);

  await log('[terraform] apply (from tfplan)');
  const applyCode = await runCommand(
    config.terraformBin,
    ['apply', '-input=false', '-no-color', 'tfplan'],
    generatedDir,
    log
  );

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

/** @deprecated Use runLifecycle(..., 'apply') */
export async function runInfrastructureDeploy(
  infra: Infrastructure,
  deployment: Deployment
): Promise<void> {
  return runLifecycle(infra, deployment, 'apply');
}
