import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { cliChildEnv, config } from '../config';
import type { Infrastructure } from '../types/api';
import type { DriftReport } from '../types/gitops';
import { hashContent } from './gitopsHash';
import { saveInfrastructure } from '../store/memoryStore';

function runCapture(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: cliChildEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function ensureGenerated(infra: Infrastructure, generatedDir: string): Promise<number> {
  const gitPath = infra.gitPath?.replace(/\\/g, '/').replace(/^\.\//, '');
  const writeArchive = Boolean(
    gitPath && !gitPath.startsWith('archive/') && gitPath.endsWith('.json')
  );

  let configPath: string;
  let terraformDir = generatedDir;
  if (writeArchive && gitPath) {
    configPath = path.join(config.configRoot, gitPath);
    terraformDir = path.join(config.configRoot, 'archive', gitPath.replace(/\.json$/i, ''));
  } else {
    const workspace = path.join(config.workDir, infra.id);
    await fs.ensureDir(workspace);
    configPath = path.join(workspace, 'grid.json');
  }

  await fs.ensureDir(path.dirname(configPath));
  await fs.writeJSON(configPath, infra.configJson, { spaces: 2 });
  await fs.ensureDir(terraformDir);

  const cliEntryJs = path.join(config.cliRoot, 'dist', 'index.js');
  const cliEntryTs = path.join(config.cliRoot, 'src', 'index.ts');
  const useCompiled = await fs.pathExists(cliEntryJs);

  const args = ['generate', '--config', configPath, '--format', 'terraform'];
  if (writeArchive) {
    args.push('--config-dir', config.configRoot);
  } else {
    args.push('--output', terraformDir);
  }

  const bin = useCompiled
    ? process.execPath
    : path.join(config.cliRoot, 'node_modules', '.bin', 'tsx');
  const entry = useCompiled ? cliEntryJs : cliEntryTs;

  return (await runCapture(bin, [entry, ...args], config.cliRoot)).code;
}

/**
 * Drift = desired state (Git / configJson) vs Terraform state (live).
 * plan -detailed-exitcode: 0=sync, 2=changes, 1=error.
 */
export async function checkInfrastructureDrift(infra: Infrastructure): Promise<DriftReport> {
  const gitChangedSinceApply =
    (!!infra.gitContentHash &&
      !!infra.lastAppliedHash &&
      infra.gitContentHash !== infra.lastAppliedHash) ||
    (!!infra.gitContentHash && !infra.lastAppliedHash);

  const currentHash = hashContent(infra.configJson);
  const localUnapplied = !!infra.lastAppliedHash && infra.lastAppliedHash !== currentHash;

  const actions = {
    applyGitDesired:
      'Run Plan, then Apply to move live infrastructure toward the JSON currently in Git (desired state).',
    updateGitToMatchLive:
      'If live is correct, update the Grid JSON in your Git repo to match reality, commit, then Sync. Automatic reverse-map from state → full Grid JSON is limited; use the state inventory + Plan excerpt.',
  };

  const gitPath = infra.gitPath?.replace(/\\/g, '/').replace(/^\.\//, '');
  const workspaceGenerated =
    gitPath && !gitPath.startsWith('archive/') && gitPath.endsWith('.json')
      ? path.join(config.configRoot, 'archive', gitPath.replace(/\.json$/i, ''))
      : path.join(config.workDir, infra.id, 'generated');

  const genCode = await ensureGenerated(infra, workspaceGenerated);
  if (genCode !== 0) {
    return {
      infrastructureId: infra.id,
      kind: 'unknown',
      hasDrift: true,
      gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
      summary: 'Could not generate Terraform from desired JSON — fix config before drift check.',
      changes: ['grid generate failed'],
      actions,
      checkedAt: new Date().toISOString(),
    };
  }

  await runCapture(config.terraformBin, ['init', '-input=false'], workspaceGenerated);
  const plan = await runCapture(
    config.terraformBin,
    ['plan', '-input=false', '-no-color', '-detailed-exitcode'],
    workspaceGenerated
  );

  const excerpt = (plan.stdout || plan.stderr || '').slice(0, 20_000);
  const changes: string[] = [];
  const summaryMatch = excerpt.match(
    /Plan:\s*(\d+)\s*to add,\s*(\d+)\s*to change,\s*(\d+)\s*to destroy/
  );
  if (summaryMatch) {
    changes.push(
      `Terraform plan: ${summaryMatch[1]} to add, ${summaryMatch[2]} to change, ${summaryMatch[3]} to destroy`
    );
  }

  const show = await runCapture(config.terraformBin, ['show', '-json'], workspaceGenerated);
  if (show.code === 0 && show.stdout.trim()) {
    try {
      const state = JSON.parse(show.stdout) as {
        values?: {
          root_module?: { resources?: Array<{ type?: string; name?: string; address?: string }> };
        };
      };
      const resources = state.values?.root_module?.resources || [];
      if (resources.length) {
        changes.push(`Live state inventory (${resources.length} resources):`);
        for (const r of resources.slice(0, 40)) {
          changes.push(`  • ${r.address || `${r.type}.${r.name}`}`);
        }
      } else {
        changes.push('Live state has no resources yet (empty or not applied).');
      }
    } catch {
      // ignore
    }
  }

  if (plan.code === 0) {
    return {
      infrastructureId: infra.id,
      kind: 'in_sync',
      hasDrift: false,
      gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
      summary: 'In sync: Terraform plan reports no changes. Desired JSON matches live state.',
      changes: changes.length ? changes : ['No infrastructure changes planned.'],
      planExcerpt: excerpt.slice(0, 4000),
      actions,
      checkedAt: new Date().toISOString(),
    };
  }

  if (plan.code === 2) {
    return {
      infrastructureId: infra.id,
      kind: gitChangedSinceApply || localUnapplied ? 'desired_ahead' : 'live_drift',
      hasDrift: true,
      gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
      summary:
        gitChangedSinceApply || localUnapplied
          ? 'Desired JSON (Git) differs from live/state. Plan shows what Apply would change to match Git.'
          : 'Live drift: Terraform state does not match desired JSON (manual cloud edits or partial apply).',
      changes: changes.length
        ? changes
        : ['Terraform plan reported changes (exit code 2). Run Plan in the UI for full logs.'],
      planExcerpt: excerpt.slice(0, 8000),
      actions,
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    infrastructureId: infra.id,
    kind: 'unknown',
    hasDrift: true,
    gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
    summary: `Drift check failed (terraform exit ${plan.code}). Check credentials and module bank.`,
    changes: [plan.stderr.slice(0, 2000) || plan.stdout.slice(0, 2000) || 'Unknown terraform error'],
    planExcerpt: excerpt.slice(0, 4000),
    actions,
    checkedAt: new Date().toISOString(),
  };
}

export async function markApplied(infra: Infrastructure): Promise<Infrastructure> {
  const h = hashContent(infra.configJson);
  infra.lastAppliedHash = h;
  if (!infra.gitContentHash) infra.gitContentHash = h;
  infra.updatedAt = new Date().toISOString();
  return saveInfrastructure(infra);
}
