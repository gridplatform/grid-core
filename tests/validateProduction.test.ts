import { afterEach, describe, expect, it } from 'vitest';
import {
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
});
