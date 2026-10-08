import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

export type GridAppEnv = 'development' | 'production';

/** True when the mode's env file (or development fallback) was loaded from disk. */
let envFileLoaded = false;

export function didLoadEnvFile(): boolean {
  return envFileLoaded;
}

/**
 * Resolve which env *file* to load. Set by npm scripts (`GRID_APP_ENV=…`),
 * not by a key inside the file — `.env.development` vs `.env` is the mode.
 */
export function resolveAppEnv(): GridAppEnv {
  const raw = (
    process.env.GRID_APP_ENV ||
    process.env.GRID_ENV ||
    (process.env.NODE_ENV === 'production' ? 'production' : 'development')
  )
    .trim()
    .toLowerCase();
  return raw === 'production' || raw === 'prod' ? 'production' : 'development';
}

/**
 * One file each, never mixed:
 * - development → `.env.development` (`npm run dev`)
 * - production  → `.env` (`npm start` / `npm run prod`)
 */
export function loadAppEnv(cwd = process.cwd()): GridAppEnv {
  const appEnv = resolveAppEnv();
  process.env.GRID_APP_ENV = appEnv;
  envFileLoaded = false;

  const file =
    appEnv === 'development'
      ? path.join(cwd, '.env.development')
      : path.join(cwd, '.env');

  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: true });
    envFileLoaded = true;
  } else if (appEnv === 'development' && fs.existsSync(path.join(cwd, '.env'))) {
    // Soft fallback so a lone `.env` still works if `.env.development` is missing.
    console.warn(
      '[grid] GRID_APP_ENV=development but .env.development is missing — falling back to .env'
    );
    dotenv.config({ path: path.join(cwd, '.env'), override: true });
    envFileLoaded = true;
  }

  process.env.GRID_APP_ENV = appEnv;

  if (appEnv === 'development') {
    applyDevelopmentDefaults(cwd);
  } else {
    applyProductionDefaults();
  }

  return appEnv;
}

/** Local laptop defaults so archive/ + module bank are visible on disk. */
function applyDevelopmentDefaults(cwd: string): void {
  const siblingConfig = path.resolve(cwd, '../grid-config');
  const siblingBank = path.resolve(cwd, '../grid-terraform');
  const siblingCli = path.resolve(cwd, '../grid-cli');

  if (!process.env.GRID_CLI_ROOT && fs.existsSync(siblingCli)) {
    process.env.GRID_CLI_ROOT = siblingCli;
  }
  if (!process.env.GRID_CONFIG_ROOT && fs.existsSync(siblingConfig)) {
    process.env.GRID_CONFIG_ROOT = siblingConfig;
  }
  if (!process.env.GRID_MODULE_BANK && fs.existsSync(siblingBank)) {
    process.env.GRID_MODULE_BANK = siblingBank;
  }
  if (!process.env.GRID_MODULE_SOURCE) {
    process.env.GRID_MODULE_SOURCE = isGitUrl(process.env.GRID_MODULE_BANK || '')
      ? 'remote'
      : 'link';
  }
  if (!process.env.GRID_DATA_DIR) {
    process.env.GRID_DATA_DIR = path.join(cwd, 'data');
  }
  if (!process.env.GRID_WORK_DIR) {
    process.env.GRID_WORK_DIR = path.join(cwd, 'workspaces');
  }
  if (process.env.GRID_GITOPS_SYNC_INTERVAL_SEC === undefined) {
    process.env.GRID_GITOPS_SYNC_INTERVAL_SEC = '0';
  }
}

function applyProductionDefaults(): void {
  if (!process.env.GRID_MODULE_SOURCE) {
    process.env.GRID_MODULE_SOURCE = 'remote';
  }
  if (!process.env.GRID_MODULE_BANK?.trim()) {
    process.env.GRID_MODULE_BANK =
      'https://github.com/gridplatform/grid-terraform.git';
  }
  if (
    !process.env.GRID_MODULE_BANK_REF?.trim() &&
    !process.env.GRID_MODULE_BANK_BRANCH?.trim()
  ) {
    process.env.GRID_MODULE_BANK_REF = 'v0.1.0';
  }
  if (
    process.env.GRID_MODULE_BANK_SYNC_INTERVAL_SEC === undefined ||
    process.env.GRID_MODULE_BANK_SYNC_INTERVAL_SEC === ''
  ) {
    process.env.GRID_MODULE_BANK_SYNC_INTERVAL_SEC = '20';
  }
}

function isGitUrl(value: string): boolean {
  const v = value.trim();
  return /^https?:\/\//i.test(v) || /^git@/i.test(v) || /^git::/i.test(v);
}
