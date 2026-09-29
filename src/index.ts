import fs from 'fs-extra';
import { createApp } from './app';
import { config } from './config';
import { loadGitOpsSettings } from './store/gitopsStore';
import { syncGitOpsRepo } from './services/gitopsSyncService';

async function main() {
  await fs.ensureDir(config.dataDir);
  await fs.ensureDir(config.workDir);
  await fs.ensureDir(config.configRoot);

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`grid-core listening on http://localhost:${config.port}`);
    console.log(`CLI root:      ${config.cliRoot}`);
    console.log(`Config root:   ${config.configRoot}`);
    console.log(`Module bank:   ${config.moduleBank}`);
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

  // Ensure desired-state tree exists (clone if empty + remote configured).
  const settings = await loadGitOpsSettings();
  if (settings?.enabled && settings.repoUrl) {
    try {
      const result = await syncGitOpsRepo();
      console.log(
        `[gitops] initial sync: ${result.synced} files` +
          (result.commit ? ` @ ${result.commit.slice(0, 8)}` : '')
      );
    } catch (err) {
      console.error('[gitops] initial sync failed', err instanceof Error ? err.message : err);
    }
    if (settings.syncIntervalSec > 0) {
      const ms = settings.syncIntervalSec * 1000;
      console.log(`GitOps auto-sync every ${settings.syncIntervalSec}s`);
      setInterval(() => {
        void syncGitOpsRepo().catch((err) =>
          console.error('[gitops] sync failed', err instanceof Error ? err.message : err)
        );
      }, ms);
    }
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
