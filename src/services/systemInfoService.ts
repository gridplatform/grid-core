import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { config } from '../config';

const execFileAsync = promisify(execFile);

function readPackageVersion(pkgDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

async function terraformVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(config.terraformBin, ['version', '-json'], {
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    });
    const parsed = JSON.parse(stdout) as { terraform_version?: string };
    return parsed.terraform_version || null;
  } catch {
    try {
      const { stdout } = await execFileAsync(config.terraformBin, ['version'], {
        timeout: 8_000,
        maxBuffer: 256 * 1024,
      });
      const line = stdout.split('\n')[0] || '';
      const m = line.match(/v?(\d+\.\d+\.\d+)/);
      return m ? m[1] : line.trim() || null;
    } catch {
      return null;
    }
  }
}

export interface SystemVersionInfo {
  core: { name: string; version: string };
  cli: { name: string; version: string | null; root: string };
  runtime: {
    node: string;
    platform: string;
    arch: string;
  };
  terraform: { binary: string; version: string | null };
  appEnv: 'development' | 'production';
  moduleBank: { source: string; ref: string };
  gitops: { branch: string; repoConfigured: boolean };
  paths: {
    configRoot: string;
    archiveRoot: string;
    workDir: string;
    dataDir: string;
  };
}

export async function getSystemVersionInfo(): Promise<SystemVersionInfo> {
  const coreRoot = path.resolve(__dirname, '..', '..');
  const coreVersion = readPackageVersion(coreRoot) || '0.0.0';
  const cliVersion = readPackageVersion(config.cliRoot);

  return {
    core: { name: 'grid-core', version: coreVersion },
    cli: {
      name: 'grid-cli',
      version: cliVersion,
      root: config.cliRoot,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    terraform: {
      binary: config.terraformBin,
      version: await terraformVersion(),
    },
    appEnv: config.appEnv,
    moduleBank: {
      source: config.moduleBank,
      ref: (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getActiveModuleBankVersion } = require('./moduleBankService') as {
            getActiveModuleBankVersion: () => string;
          };
          return getActiveModuleBankVersion();
        } catch {
          return config.moduleBankRef;
        }
      })(),
    },
    gitops: {
      branch: config.gitops.branch,
      repoConfigured: Boolean(config.gitops.repoUrl),
    },
    paths: {
      configRoot: config.configRoot,
      archiveRoot: path.join(config.configRoot, 'archive'),
      workDir: config.workDir,
      dataDir: config.dataDir,
    },
  };
}
