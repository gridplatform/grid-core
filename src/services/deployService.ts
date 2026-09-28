import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { config } from '../config';
import type { Deployment, Infrastructure } from '../types/api';
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
      env: process.env,
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

/**
 * Generate Terraform via grid-cli source, then terraform init/plan/apply.
 */
export async function runInfrastructureDeploy(
  infra: Infrastructure,
  deployment: Deployment
): Promise<void> {
  const workspace = path.join(config.workDir, infra.id);
  await fs.ensureDir(workspace);

  const configPath = path.join(workspace, 'grid.json');
  await fs.writeJSON(configPath, infra.configJson, { spaces: 2 });

  const generatedDir = path.join(workspace, 'generated');
  await fs.ensureDir(generatedDir);

  const log = async (line: string) => {
    await appendDeploymentLog(deployment.id, line);
  };

  deployment.status = 'running';
  deployment.progress = 10;
  await saveDeployment(deployment);

  await log(`[grid] workspace=${workspace}`);
  await log('[grid] generating terraform from config...');

  // Prefer calling compiled CLI; fall back to tsx on source.
  const cliEntryJs = path.join(config.cliRoot, 'dist', 'index.js');
  const cliEntryTs = path.join(config.cliRoot, 'src', 'index.ts');
  const useCompiled = await fs.pathExists(cliEntryJs);

  const genCode = useCompiled
    ? await runCommand(
        process.execPath,
        [cliEntryJs, 'generate', '--config', configPath, '--output', generatedDir, '--format', 'terraform'],
        config.cliRoot,
        log
      )
    : await runCommand(
        path.join(config.cliRoot, 'node_modules', '.bin', 'tsx'),
        [cliEntryTs, 'generate', '--config', configPath, '--output', generatedDir, '--format', 'terraform'],
        config.cliRoot,
        log
      );

  if (genCode !== 0) {
    deployment.status = 'failed';
    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    await saveDeployment(deployment);
    infra.status = 'error';
    infra.updatedAt = new Date().toISOString();
    await saveInfrastructure(infra);
    await log('[grid] generate failed');
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
    deployment.status = 'failed';
    deployment.completedAt = new Date().toISOString();
    await saveDeployment(deployment);
    infra.status = 'error';
    await saveInfrastructure(infra);
    return;
  }

  deployment.progress = 60;
  await saveDeployment(deployment);
  await log('[terraform] plan');

  await runCommand(
    config.terraformBin,
    ['plan', '-input=false', '-no-color'],
    generatedDir,
    log
  );

  deployment.progress = 75;
  await saveDeployment(deployment);

  const applyArgs = ['apply', '-input=false', '-no-color'];
  if (config.autoApprove) {
    applyArgs.push('-auto-approve');
  }

  await log(`[terraform] apply ${config.autoApprove ? '(auto-approve)' : ''}`);
  const applyCode = await runCommand(
    config.terraformBin,
    applyArgs,
    generatedDir,
    log
  );

  deployment.progress = 100;
  deployment.completedAt = new Date().toISOString();

  if (applyCode === 0) {
    deployment.status = 'success';
    infra.status = 'running';
    await log('[grid] deploy succeeded');
  } else {
    deployment.status = 'failed';
    infra.status = 'error';
    await log('[grid] deploy failed');
  }

  infra.updatedAt = new Date().toISOString();
  await saveDeployment(deployment);
  await saveInfrastructure(infra);
}
