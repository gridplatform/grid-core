import fs from 'fs-extra';
import { createApp } from './app';
import { config } from './config';
import { ensureBootstrapAdmin } from './auth/authService';
import { loadGitOpsSettings } from './store/gitopsStore';
import {
  effectiveGitOpsSyncIntervalSec,
  startGitOpsAutoSync,
} from './services/gitopsAutoSync';
import {
  ensureModuleBankPresent,
  moduleBankIsRemote,
  moduleBankLocalPath,
  startModuleBankAutoSync,
} from './services/moduleBankService';
import { syncGitOpsRepo } from './services/gitopsSyncService';

async function main() {
  await fs.ensureDir(config.dataDir);
  await fs.ensureDir(config.workDir);
  await fs.ensureDir(config.configRoot);

  if (!config.auth.disabled) {
    await ensureBootstrapAdmin();
  } else {
    console.warn('[auth] GRID_AUTH_DISABLED — API is open; demo user is used for audit fields.');
  }

  // Module bank: clone once onto disk/PVC; generate uses this path (no per-request fetch).
  try {
    const mb = await ensureModuleBankPresent();
    console.log(
      `[module-bank] ready at ${mb.localPath}` +
        (mb.lastCommit ? ` @ ${mb.lastCommit.slice(0, 8)}` : '') +
        (mb.remote ? ' (remote checkout)' : ' (local path)')
    );
  } catch (err) {
    console.error(
      '[module-bank] ensure failed',
      err instanceof Error ? err.message : err
    );
  }

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`grid-core listening on http://localhost:${config.port}`);
    console.log(`CLI root:      ${config.cliRoot}`);
    console.log(`Config root:   ${config.configRoot}`);
    console.log(`Module bank:   ${config.moduleBank}`);
    console.log(`Module bank local: ${moduleBankLocalPath()}`);
    console.log(`Module bank ref: ${config.moduleBankRef}`);
    console.log(`Work dir:      ${config.workDir}`);
    if (config.gitops.repoUrl) {
      console.log(`GitOps remote: ${config.gitops.repoUrl} (${config.gitops.branch})`);
    }
    if (config.configRootIsDemoFixture) {
      console.warn(
        '[grid-core] GRID_CONFIG_ROOT is the demo-infra test fixture — not a customer config. ' +
          'For normal use: set GRID_GITOPS_REPO_URL / GRID_CONFIG_ROOT to your desired-state repo.'
      );
    }
  });

  if (moduleBankIsRemote() && config.moduleBankSyncIntervalSec > 0) {
    startModuleBankAutoSync(config.moduleBankSyncIntervalSec);
  }

  // Ensure desired-state tree exists (clone if empty + remote configured).
  const settings = await loadGitOpsSettings();
  if (settings?.enabled && settings.repoUrl) {
    try {
      const result = await syncGitOpsRepo();
      if (result) {
        console.log(
          `[gitops] initial sync: ${result.synced} files` +
            (result.commit ? ` @ ${result.commit.slice(0, 8)}` : '')
        );
      }
    } catch (err) {
      console.error('[gitops] initial sync failed', err instanceof Error ? err.message : err);
    }
    const intervalSec = effectiveGitOpsSyncIntervalSec(settings);
    startGitOpsAutoSync(intervalSec);
  }

  // Populate infra store in the background so /projects stays snappy.
  void import('./services/configRootSync')
    .then(({ syncInfrastructuresFromConfigRoot }) =>
      syncInfrastructuresFromConfigRoot({ force: true })
    )
    .then((r) => console.log(`[config] store sync: ${r.synced} units`))
    .catch((err) =>
      console.error('[config] store sync failed', err instanceof Error ? err.message : err)
    );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
