import path from 'path';
import fs from 'fs-extra';
import { installConsoleTimestamps } from './lib/log';
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
  getActiveModuleBankVersion,
  loadModuleBankSettings,
  moduleBankIsRemote,
  moduleBankLocalPath,
  restartModuleBankAutoSync,
} from './services/moduleBankService';
import { syncGitOpsRepo } from './services/gitopsSyncService';
import { didLoadEnvFile } from './loadEnv';
import {
  assertProductionReady,
  assertTfBackendConfigOrThrow,
} from './validateProduction';
import { assertArchiveMirrorReady } from './services/archiveMirror';

installConsoleTimestamps();

async function main() {
  await fs.ensureDir(config.dataDir);
  await fs.ensureDir(config.workDir);
  await fs.ensureDir(config.configRoot);

  // Incomplete GRID_TF_BACKEND=s3|… always fails (generate would break later).
  assertTfBackendConfigOrThrow();

  if (!config.auth.disabled) {
    await ensureBootstrapAdmin();
  } else {
    console.warn('[auth] GRID_AUTH_DISABLED — API is open; demo user is used for audit fields.');
  }

  // Module bank: load admin version settings, ensure checkout, start auto-sync.
  const mbSettings = await loadModuleBankSettings();

  // Production: require .env + remote state + git module bank @ release tag (e.g. v0.1.0).
  if (config.isProduction) {
    assertProductionReady({
      envFileLoaded: didLoadEnvFile(),
      moduleBankVersion: mbSettings.version,
    });
    // Hard gate: same state bucket must accept archive/ put+delete (exit buffer).
    await assertArchiveMirrorReady();
  }

  try {
    const mb = await ensureModuleBankPresent();
    console.log(
      `[module-bank] ready at ${mb.localPath}` +
        ` version=${mbSettings.version}` +
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
    console.log(`App env:       ${config.appEnv} (${config.isDevelopment ? 'npm run dev' : 'npm run prod / start'})`);
    console.log(`CLI root:      ${config.cliRoot}`);
    console.log(`Config root:   ${config.configRoot}`);
    console.log(`Archive TF:    ${path.join(config.configRoot, 'archive')}  ← local generated Terraform`);
    if (config.isProduction) {
      console.log(`Archive mirror: <state-bucket>/archive/…  ← durable exit buffer (same store as TF state)`);
    }
    console.log(`Module bank:   ${config.moduleBank}`);
    console.log(`Module bank local: ${moduleBankLocalPath()}`);
    console.log(`Module bank version: ${getActiveModuleBankVersion()}`);
    console.log(`Module bank auto-sync: ${mbSettings.syncIntervalSec}s`);
    console.log(`Work dir:      ${config.workDir}  ← scratch TF for API-only units`);
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

  if (moduleBankIsRemote()) {
    restartModuleBankAutoSync();
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

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
