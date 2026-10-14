/**
 * Boot check: Prometheus + Alertmanager reachable; monitoring config dir writable.
 * Used by npm run prod / Compose (production). Skipped in npm run dev.
 */

import path from 'path';
import fs from 'fs-extra';
import { config } from '../../config';

async function httpOk(
  url: string,
  opts?: { method?: string; timeoutMs?: number }
): Promise<{ ok: boolean; status: number; detail: string }> {
  const ctrl = new AbortController();
  const ms = opts?.timeoutMs ?? config.prometheus.timeoutMs;
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: opts?.method || 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    return {
      ok: res.ok || res.status === 204,
      status: res.status,
      detail: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(t);
  }
}

async function assertConfigDirWritable(dir: string): Promise<void> {
  await fs.ensureDir(path.join(dir, 'rules'));
  const probe = path.join(dir, 'rules', '.grid-write-probe');
  await fs.writeFile(probe, `grid-probe ${new Date().toISOString()}\n`, 'utf8');
  await fs.remove(probe);
  const amPath = path.join(dir, 'alertmanager.yml');
  if (!(await fs.pathExists(amPath))) {
    throw new Error(
      `missing ${amPath} — ensure install/monitoring/alertmanager.yml (or /etc/prometheus on the VM)`
    );
  }
  const prev = await fs.readFile(amPath, 'utf8');
  await fs.writeFile(amPath, prev, 'utf8');
}

/** Fail production boot if monitoring plane is down or config dir is not writable. */
export async function assertMonitoringPlaneReady(): Promise<void> {
  const promUrl = config.prometheus.url?.trim();
  const amUrl = config.alertmanager.url?.trim();
  const dir = config.monitoringConfigDir;
  const problems: string[] = [];

  if (!promUrl) {
    problems.push('GRID_PROMETHEUS_URL is not set');
  }
  if (!amUrl) {
    problems.push('GRID_ALERTMANAGER_URL is not set');
  }

  if (promUrl) {
    const ready = await httpOk(`${promUrl}/-/ready`);
    if (!ready.ok) {
      problems.push(
        `Prometheus not ready at ${promUrl}/-/ready (${ready.detail})`
      );
    } else {
      const reload = await httpOk(`${promUrl}/-/reload`, { method: 'POST' });
      if (!reload.ok) {
        problems.push(
          `Prometheus reload failed at ${promUrl}/-/reload (${reload.detail}) — need --web.enable-lifecycle`
        );
      }
    }
  }

  if (amUrl) {
    const ready = await httpOk(`${amUrl}/-/ready`);
    if (!ready.ok) {
      const status = await httpOk(`${amUrl}/api/v2/status`);
      if (!status.ok) {
        problems.push(
          `Alertmanager not ready at ${amUrl} (/-/ready ${ready.detail}; /api/v2/status ${status.detail})`
        );
      }
    } else {
      const reload = await httpOk(`${amUrl}/-/reload`, { method: 'POST' });
      if (!reload.ok) {
        problems.push(
          `Alertmanager reload failed at ${amUrl}/-/reload (${reload.detail})`
        );
      }
    }
  }

  try {
    await assertConfigDirWritable(dir);
  } catch (err) {
    problems.push(
      `GRID_MONITORING_CONFIG_DIR=${dir} not writable: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `[grid-core] production boot refused — monitoring plane not ready\n` +
        `  GRID_PROMETHEUS_URL=${promUrl || '(not set)'}\n` +
        `  GRID_ALERTMANAGER_URL=${amUrl || '(not set)'}\n` +
        `  GRID_MONITORING_CONFIG_DIR=${dir}\n` +
        `\nIssues:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nOperate:\n` +
        `  Local: 127.0.0.1 + ./install/monitoring — install/monitoring/README.md\n` +
        `  VM: host.docker.internal + /etc/prometheus — install-systemd.sh`
    );
  }

  console.log(
    `[grid-core] monitoring plane OK — prometheus=${promUrl} alertmanager=${amUrl} config=${dir}`
  );
}
