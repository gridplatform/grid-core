/**
 * Talk to Argo CD / OpenShift GitOps via kubectl (same CRDs).
 * Grid does not shell out kubectl apply for app workloads — only Application CRs.
 */
import { spawn } from 'child_process';
import { config } from '../../config';

export type KubectlResult = { code: number; stdout: string; stderr: string };

function kubectlEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.argo.kubeconfig) {
    env.KUBECONFIG = config.argo.kubeconfig;
  }
  if (config.argo.context) {
    // applied via --context flag
  }
  return env;
}

export async function runKubectl(
  args: string[],
  opts?: { input?: string }
): Promise<KubectlResult> {
  const bin = config.argo.kubectlBin;
  const full = [...args];
  if (config.argo.context) {
    full.unshift('--context', config.argo.context);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, full, {
      env: kubectlEnv(),
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    if (opts?.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function applyApplicationYaml(yaml: string): Promise<KubectlResult> {
  return runKubectl(['apply', '-f', '-'], { input: yaml });
}

export async function deleteApplication(
  name: string,
  namespace: string
): Promise<KubectlResult> {
  return runKubectl([
    'delete',
    'application.argoproj.io',
    name,
    '-n',
    namespace,
    '--ignore-not-found=true',
  ]);
}

export async function getApplicationJson(
  name: string,
  namespace: string
): Promise<{ code: number; app?: Record<string, unknown>; raw: string }> {
  const result = await runKubectl([
    'get',
    'application.argoproj.io',
    name,
    '-n',
    namespace,
    '-o',
    'json',
  ]);
  if (result.code !== 0) {
    return { code: result.code, raw: result.stderr || result.stdout };
  }
  try {
    return { code: 0, app: JSON.parse(result.stdout) as Record<string, unknown>, raw: result.stdout };
  } catch {
    return { code: 1, raw: result.stdout };
  }
}

/** Trigger a sync (plan≈diff is separate; apply uses this). */
export async function syncApplication(
  name: string,
  namespace: string,
  opts?: { prune?: boolean; dryRun?: boolean }
): Promise<KubectlResult> {
  // Prefer argocd CLI when present; fall back to annotating the Application.
  if (opts?.dryRun) {
    return runKubectl([
      'get',
      'application.argoproj.io',
      name,
      '-n',
      namespace,
      '-o',
      'yaml',
    ]);
  }
  const patch = {
    metadata: {
      annotations: {
        'argocd.argoproj.io/refresh': 'hard',
      },
    },
    operation: {
      initiatedBy: { username: 'grid' },
      sync: {
        prune: opts?.prune !== false,
        syncStrategy: { apply: { force: false } },
      },
    },
  };
  return runKubectl([
    'patch',
    'application.argoproj.io',
    name,
    '-n',
    namespace,
    '--type',
    'merge',
    '-p',
    JSON.stringify(patch),
  ]);
}

export function assertArgoConfigured(): void {
  if (!config.argo.enabled) {
    throw new Error(
      'Kubernetes GitOps is disabled. Set GRID_ARGO_ENABLED=1 and GRID_ARGO_KUBECONFIG (or KUBECONFIG) to the cluster where Argo CD / OpenShift GitOps runs.'
    );
  }
}
