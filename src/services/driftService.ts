import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import { cliChildEnv, config } from '../config';
import { writeJsonAtomic } from '../lib/jsonFile';
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

function slugSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Same archive/ layout as lifecycleService — drift must run terraform where
 * generate wrote files (and where remote state is keyed).
 */
export function resolveDriftTerraformDirs(infra: Infrastructure): {
  configPath: string;
  terraformDir: string;
  writeArchive: boolean;
  derivedGitPath?: string;
} {
  const gitPath = infra.gitPath?.replace(/\\/g, '/').replace(/^\.\//, '');
  if (gitPath && !gitPath.startsWith('archive/') && gitPath.endsWith('.json')) {
    const unitRel = gitPath.replace(/\.json$/i, '');
    return {
      configPath: path.join(config.configRoot, gitPath),
      terraformDir: path.join(config.configRoot, 'archive', unitRel),
      writeArchive: true,
    };
  }

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
  if (project && provider && environment && type && name) {
    const unitRel = `projects/${project}/${provider}/${environment}/${type}/${name}`;
    const derivedGitPath = `${unitRel}.json`;
    return {
      configPath: path.join(config.configRoot, derivedGitPath),
      terraformDir: path.join(config.configRoot, 'archive', unitRel),
      writeArchive: true,
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

async function ensureGenerated(
  infra: Infrastructure
): Promise<{ code: number; terraformDir: string; stderr: string }> {
  const dirs = resolveDriftTerraformDirs(infra);
  if (dirs.derivedGitPath && !infra.gitPath) {
    infra.gitPath = dirs.derivedGitPath;
    infra.updatedAt = new Date().toISOString();
    await saveInfrastructure(infra);
  }

  await fs.ensureDir(path.dirname(dirs.configPath));
  await writeJsonAtomic(dirs.configPath, infra.configJson);
  await fs.ensureDir(dirs.terraformDir);

  const cliEntryJs = path.join(config.cliRoot, 'dist', 'index.js');
  const cliEntryTs = path.join(config.cliRoot, 'src', 'index.ts');
  const useCompiled = await fs.pathExists(cliEntryJs);

  const args = ['generate', '--config', dirs.configPath, '--format', 'terraform'];
  if (dirs.writeArchive) {
    args.push('--config-dir', config.configRoot);
  } else {
    args.push('--output', dirs.terraformDir);
  }

  const bin = useCompiled
    ? process.execPath
    : path.join(config.cliRoot, 'node_modules', '.bin', 'tsx');
  const entry = useCompiled ? cliEntryJs : cliEntryTs;

  const result = await runCapture(bin, [entry, ...args], config.cliRoot);
  return {
    code: result.code,
    terraformDir: dirs.terraformDir,
    stderr: result.stderr || result.stdout,
  };
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

  let gen: { code: number; terraformDir: string; stderr: string };
  try {
    gen = await ensureGenerated(infra);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      infrastructureId: infra.id,
      kind: 'unknown',
      hasDrift: true,
      gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
      summary: `Drift check failed while generating Terraform: ${msg}`,
      changes: [msg],
      actions,
      checkedAt: new Date().toISOString(),
    };
  }

  if (gen.code !== 0) {
    return {
      infrastructureId: infra.id,
      kind: 'unknown',
      hasDrift: true,
      gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
      summary: 'Could not generate Terraform from desired JSON — fix config before drift check.',
      changes: [
        'grid generate failed',
        ...(gen.stderr ? [gen.stderr.slice(0, 2000)] : []),
      ],
      actions,
      checkedAt: new Date().toISOString(),
    };
  }

  const terraformDir = gen.terraformDir;
  const hasTf = (await fs.pathExists(path.join(terraformDir, 'main.tf'))) ||
    (await fs.pathExists(path.join(terraformDir, 'versions.tf'))) ||
    (await fs.readdir(terraformDir).catch(() => [])).some((f) => f.endsWith('.tf'));

  if (!hasTf) {
    return {
      infrastructureId: infra.id,
      kind: 'unknown',
      hasDrift: true,
      gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
      summary: `Generate reported success but no .tf files in ${terraformDir}`,
      changes: [`Expected Terraform under ${terraformDir}`],
      actions,
      checkedAt: new Date().toISOString(),
    };
  }

  const init = await runCapture(
    config.terraformBin,
    ['init', '-input=false', '-no-color'],
    terraformDir
  );
  if (init.code !== 0) {
    const detail = (init.stderr || init.stdout || '').slice(0, 4000);
    return {
      infrastructureId: infra.id,
      kind: 'unknown',
      hasDrift: true,
      gitChangedSinceApply: gitChangedSinceApply || localUnapplied,
      summary: 'Drift check failed: terraform init error (credentials, backend, or modules).',
      changes: [detail || `terraform init exited ${init.code}`],
      planExcerpt: detail,
      actions,
      checkedAt: new Date().toISOString(),
    };
  }

  const plan = await runCapture(
    config.terraformBin,
    ['plan', '-input=false', '-no-color', '-detailed-exitcode'],
    terraformDir
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

  const show = await runCapture(
    config.terraformBin,
    ['show', '-json'],
    terraformDir
  );
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
        : ['Terraform plan reported changes (exit code 2). See plan excerpt below.'],
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
    changes: [
      (plan.stderr || plan.stdout || 'Unknown terraform error').slice(0, 2000),
    ],
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
