/**
 * Kubernetes workload lifecycle via Argo CD Application CRs.
 * Mirrors Terraform lifecycle: generate → plan/diff → apply/sync → destroy.
 */
import path from 'node:path';
import fs from 'fs-extra';
import { config } from '../../config';
import { writeJsonAtomic } from '../../lib/jsonFile';
import type { Deployment, Infrastructure, LifecycleMode } from '../../types/api';
import {
  appendDeploymentLog,
  getDeployment,
  saveDeployment,
  saveInfrastructure,
} from '../../store/memoryStore';
import {
  applicationManifestToYaml,
  mapWorkloadToArgoApplication,
  WorkloadMapError,
} from './applicationMapper';
import {
  applyApplicationYaml,
  assertArgoConfigured,
  deleteApplication,
  getApplicationJson,
  syncApplication,
} from './argoClient';
import { isWorkloadIntent } from './workloadTypes';

async function stillActive(deployment: Deployment): Promise<boolean> {
  const latest = await getDeployment(deployment.id);
  return !!latest && latest.status !== 'cancelled';
}

function unitRelFromInfra(infra: Infrastructure): string {
  const gitPath = infra.gitPath?.replace(/\\/g, '/').replace(/^\.\//, '');
  if (gitPath?.endsWith('.json')) return gitPath.replace(/\.json$/i, '');
  return `workloads/${infra.project || 'default'}/${infra.environment}/${infra.name}`;
}

export function isKubernetesInfrastructure(infra: Infrastructure): boolean {
  const cfg = infra.configJson as Record<string, unknown> | undefined;
  if (cfg && isWorkloadIntent(cfg)) return true;
  if (cfg?.engine === 'kubernetes') return true;
  return false;
}

/**
 * Write Application YAML under configRoot/argo/<unit>/ (GitOps exit buffer,
 * analogous to archive/ for Terraform).
 */
export async function writeArgoApplicationArtifacts(
  infra: Infrastructure
): Promise<{ yamlPath: string; appName: string; argoNamespace: string }> {
  if (!isWorkloadIntent(infra.configJson)) {
    throw new WorkloadMapError(
      'Infrastructure configJson is not a kubernetes workload intent (engine=kubernetes)'
    );
  }
  const unitRel = unitRelFromInfra(infra);
  const app = mapWorkloadToArgoApplication(infra.configJson, {
    argoNamespace: config.argo.namespace,
    unitRelPath: unitRel,
  });
  const outDir = path.join(config.configRoot, 'argo', unitRel);
  await fs.ensureDir(outDir);
  const yamlPath = path.join(outDir, 'application.yaml');
  const yaml = applicationManifestToYaml(app);
  await fs.writeFile(yamlPath, yaml, 'utf8');
  await writeJsonAtomic(path.join(outDir, '.grid-generated'), {
    engine: 'kubernetes',
    gitops: 'argocd',
    generatedAt: new Date().toISOString(),
    application: app.metadata.name,
    namespace: app.metadata.namespace,
  });
  return {
    yamlPath,
    appName: app.metadata.name,
    argoNamespace: app.metadata.namespace,
  };
}

export async function runKubernetesLifecycle(
  infra: Infrastructure,
  deployment: Deployment,
  mode: LifecycleMode
): Promise<void> {
  const log = async (line: string) => {
    await appendDeploymentLog(deployment.id, line);
  };

  try {
    assertArgoConfigured();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deployment.status = 'failed';
    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.status = 'error';
    infra.updatedAt = new Date().toISOString();
    await log(`[grid] ${msg}`);
    await saveDeployment(deployment);
    await saveInfrastructure(infra);
    return;
  }

  deployment.status = mode === 'plan' ? 'planning' : 'running';
  deployment.progress = 10;
  await saveDeployment(deployment);

  let artifacts: { yamlPath: string; appName: string; argoNamespace: string };
  try {
    await log('[grid] generating Argo CD Application from workload intent…');
    artifacts = await writeArgoApplicationArtifacts(infra);
    await log(`[grid] wrote ${artifacts.yamlPath}`);
    await log(
      `[grid] Application ${artifacts.appName} (ns=${artifacts.argoNamespace}) — works with Argo CD and OpenShift GitOps`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deployment.status = 'failed';
    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.status = 'error';
    infra.updatedAt = new Date().toISOString();
    await log(`[grid] generate failed: ${msg}`);
    await saveDeployment(deployment);
    await saveInfrastructure(infra);
    return;
  }

  if (!(await stillActive(deployment))) return;
  deployment.progress = 40;
  await saveDeployment(deployment);

  if (mode === 'plan') {
    await log('[argo] plan = ensure Application CR exists + show status (diff via Argo UI/CLI)');
    const apply = await applyApplicationYaml(
      await fs.readFile(artifacts.yamlPath, 'utf8')
    );
    await log(apply.stdout || apply.stderr);
    const status = await getApplicationJson(artifacts.appName, artifacts.argoNamespace);
    if (status.app) {
      const sync = (status.app.status as { sync?: { status?: string } } | undefined)?.sync
        ?.status;
      const health = (status.app.status as { health?: { status?: string } } | undefined)?.health
        ?.status;
      deployment.planSummary = `Argo Application ${artifacts.appName}\nsync=${sync || 'Unknown'} health=${health || 'Unknown'}\n\nFull diff: argocd app diff ${artifacts.appName} (or OpenShift GitOps console)`;
      await log(`[argo] sync=${sync || '?'} health=${health || '?'}`);
    } else {
      await log(`[argo] status: ${status.raw.slice(0, 2000)}`);
      deployment.planSummary = status.raw.slice(0, 50_000);
    }
    if (!(await stillActive(deployment))) return;
    deployment.status = apply.code === 0 ? 'success' : 'failed';
    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.status = apply.code === 0 ? 'pending' : 'error';
    infra.updatedAt = new Date().toISOString();
    await log(apply.code === 0 ? '[grid] plan succeeded' : '[grid] plan failed');
    await saveDeployment(deployment);
    await saveInfrastructure(infra);
    return;
  }

  if (mode === 'destroy') {
    await log(`[argo] delete Application ${artifacts.appName}`);
    const del = await deleteApplication(artifacts.appName, artifacts.argoNamespace);
    await log(del.stdout || del.stderr);
    await fs.remove(path.dirname(artifacts.yamlPath)).catch(() => undefined);
    if (!(await stillActive(deployment))) return;
    deployment.status = del.code === 0 ? 'success' : 'failed';
    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    // Config-driven: keep catalog row as pending when intent JSON remains.
    infra.status = del.code === 0 ? 'pending' : 'error';
    infra.lastAppliedHash = undefined;
    infra.updatedAt = new Date().toISOString();
    await log(
      del.code === 0
        ? '[grid] destroy succeeded — unit kept pending (intent JSON still owns the name)'
        : '[grid] destroy failed'
    );
    await saveDeployment(deployment);
    await saveInfrastructure(infra);
    return;
  }

  // apply
  await log('[argo] apply Application CR');
  const apply = await applyApplicationYaml(await fs.readFile(artifacts.yamlPath, 'utf8'));
  await log(apply.stdout || apply.stderr);
  if (apply.code !== 0) {
    deployment.status = 'failed';
    deployment.progress = 100;
    deployment.completedAt = new Date().toISOString();
    infra.status = 'error';
    infra.updatedAt = new Date().toISOString();
    await log('[grid] apply failed (Application CR)');
    await saveDeployment(deployment);
    await saveInfrastructure(infra);
    return;
  }

  deployment.progress = 70;
  await saveDeployment(deployment);
  await log('[argo] sync Application');
  const sync = await syncApplication(artifacts.appName, artifacts.argoNamespace, {
    prune: true,
  });
  await log(sync.stdout || sync.stderr);

  if (!(await stillActive(deployment))) return;
  const ok = sync.code === 0;
  deployment.status = ok ? 'success' : 'failed';
  deployment.progress = 100;
  deployment.completedAt = new Date().toISOString();
  infra.status = ok ? 'running' : 'error';
  infra.updatedAt = new Date().toISOString();
  await log(ok ? '[grid] apply succeeded (Argo sync requested)' : '[grid] apply sync failed');
  await saveDeployment(deployment);
  await saveInfrastructure(infra);
}
