import fs from 'fs-extra';
import { createApp } from './app';
import { config } from './config';
import { loadGitOpsSettings } from './store/gitopsStore';
import { syncGitOpsRepo } from './services/gitopsSyncService';

async function main() {
  await fs.ensureDir(config.dataDir);
  await fs.ensureDir(config.workDir);

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`grid-core listening on http://localhost:${config.port}`);
    console.log(`CLI root:      ${config.cliRoot}`);
    console.log(`Config root:   ${config.configRoot}`);
    console.log(`Module bank:   ${config.moduleBank}`);
    console.log(`Work dir:      ${config.workDir}`);
  });

  // Optional background GitOps sync
  const settings = await loadGitOpsSettings();
  if (settings?.enabled && settings.syncIntervalSec > 0 && settings.repoUrl) {
    const ms = settings.syncIntervalSec * 1000;
    console.log(`GitOps auto-sync every ${settings.syncIntervalSec}s`);
    setInterval(() => {
      void syncGitOpsRepo().catch((err) =>
        console.error('[gitops] sync failed', err instanceof Error ? err.message : err)
      );
    }, ms);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
