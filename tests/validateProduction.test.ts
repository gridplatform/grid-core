import { afterEach, describe, expect, it } from 'vitest';
import {
  collectGitopsFindings,
  collectMonitoringFindings,
  isGitRemoteBank,
  isReleaseModuleBankRef,
  resolveTfBackendMode,
  tfBackendConfigProblems,
} from '../src/validateProduction';

const KEYS = [
  'GRID_TF_BACKEND',
  'GRID_TF_STATE_BUCKET',
  'GRID_TF_LOCK_TABLE',
  'GRID_TF_STATE_REGION',
  'GRID_TF_AZURE_RESOURCE_GROUP',
  'GRID_TF_AZURE_STORAGE_ACCOUNT',
  'GRID_TF_AZURE_CONTAINER',
] as const;

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
    delete saved[key];
  }
});

function setEnv( partial: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of Object.keys(partial) as Array<(typeof KEYS)[number]>) {
    if (!(key in saved)) saved[key] = process.env[key];
    const value = partial[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('validateProduction helpers', () => {
  it('detects git remote banks', () => {
    expect(isGitRemoteBank('https://github.com/org/repo.git')).toBe(true);
    expect(isGitRemoteBank('git@github.com:org/repo.git')).toBe(true);
    expect(isGitRemoteBank('../grid-terraform')).toBe(false);
  });

  it('resolves backend modes', () => {
    setEnv({ GRID_TF_BACKEND: 's3' });
    expect(resolveTfBackendMode()).toBe('s3');
    setEnv({ GRID_TF_BACKEND: undefined });
    expect(resolveTfBackendMode()).toBe('local');
  });

  it('requires bucket + lock table for s3', () => {
    setEnv({
      GRID_TF_BACKEND: 's3',
      GRID_TF_STATE_BUCKET: undefined,
      GRID_TF_LOCK_TABLE: undefined,
    });
    const problems = tfBackendConfigProblems();
    expect(problems.some((p) => p.includes('GRID_TF_STATE_BUCKET'))).toBe(true);
    expect(problems.some((p) => p.includes('GRID_TF_LOCK_TABLE'))).toBe(true);

    setEnv({
      GRID_TF_BACKEND: 's3',
      GRID_TF_STATE_BUCKET: 'bucket',
      GRID_TF_LOCK_TABLE: 'locks',
    });
    expect(tfBackendConfigProblems()).toEqual([]);
  });

  it('validates release refs', () => {
    expect(isReleaseModuleBankRef('v0.1.0')).toBe(true);
    expect(isReleaseModuleBankRef('main')).toBe(false);
  });

  it('requires prometheus + alertmanager URLs', () => {
    const savedProm = process.env.GRID_PROMETHEUS_URL;
    const savedAm = process.env.GRID_ALERTMANAGER_URL;
    delete process.env.GRID_PROMETHEUS_URL;
    delete process.env.GRID_ALERTMANAGER_URL;
    const missing = collectMonitoringFindings();
    expect(missing.some((f) => f.key === 'GRID_PROMETHEUS_URL')).toBe(true);
    expect(missing.some((f) => f.key === 'GRID_ALERTMANAGER_URL')).toBe(true);

    process.env.GRID_PROMETHEUS_URL = 'http://127.0.0.1:9090';
    process.env.GRID_ALERTMANAGER_URL = 'http://127.0.0.1:9093';
    expect(collectMonitoringFindings()).toEqual([]);

    if (savedProm === undefined) delete process.env.GRID_PROMETHEUS_URL;
    else process.env.GRID_PROMETHEUS_URL = savedProm;
    if (savedAm === undefined) delete process.env.GRID_ALERTMANAGER_URL;
    else process.env.GRID_ALERTMANAGER_URL = savedAm;
  });

  it('HTTPS GitOps requires username + token + expiry; SSH does not', () => {
    const savedUrl = process.env.GRID_GITOPS_REPO_URL;
    const savedUser = process.env.GRID_GITOPS_USERNAME;
    const savedTok = process.env.GRID_GITOPS_TOKEN;
    const savedExp = process.env.GRID_GITOPS_TOKEN_EXPIRES_AT;

    delete process.env.GRID_GITOPS_REPO_URL;
    delete process.env.GRID_GITOPS_USERNAME;
    delete process.env.GRID_GITOPS_TOKEN;
    delete process.env.GRID_GITOPS_TOKEN_EXPIRES_AT;
    expect(collectGitopsFindings().some((f) => f.key === 'GRID_GITOPS_REPO_URL')).toBe(
      true
    );

    process.env.GRID_GITOPS_REPO_URL = 'git@github.com:org/intent.git';
    expect(collectGitopsFindings()).toEqual([]);

    process.env.GRID_GITOPS_REPO_URL = 'https://github.com/org/intent.git';
    const missing = collectGitopsFindings();
    expect(missing.some((f) => f.key === 'GRID_GITOPS_USERNAME')).toBe(true);
    expect(missing.some((f) => f.key === 'GRID_GITOPS_TOKEN')).toBe(true);
    expect(missing.some((f) => f.key === 'GRID_GITOPS_TOKEN_EXPIRES_AT')).toBe(
      true
    );
    expect(missing.some((f) => /Without a token/i.test(f.expect))).toBe(true);

    process.env.GRID_GITOPS_USERNAME = 'git';
    process.env.GRID_GITOPS_TOKEN = 'ghp_test';
    const noExpiry = collectGitopsFindings();
    expect(noExpiry.some((f) => f.key === 'GRID_GITOPS_USERNAME')).toBe(false);
    expect(noExpiry.some((f) => f.key === 'GRID_GITOPS_TOKEN')).toBe(false);
    expect(noExpiry.some((f) => f.key === 'GRID_GITOPS_TOKEN_EXPIRES_AT')).toBe(
      true
    );

    process.env.GRID_GITOPS_TOKEN_EXPIRES_AT = '2027-01-15';
    expect(collectGitopsFindings()).toEqual([]);

    if (savedUrl === undefined) delete process.env.GRID_GITOPS_REPO_URL;
    else process.env.GRID_GITOPS_REPO_URL = savedUrl;
    if (savedUser === undefined) delete process.env.GRID_GITOPS_USERNAME;
    else process.env.GRID_GITOPS_USERNAME = savedUser;
    if (savedTok === undefined) delete process.env.GRID_GITOPS_TOKEN;
    else process.env.GRID_GITOPS_TOKEN = savedTok;
    if (savedExp === undefined) delete process.env.GRID_GITOPS_TOKEN_EXPIRES_AT;
    else process.env.GRID_GITOPS_TOKEN_EXPIRES_AT = savedExp;
  });
});
