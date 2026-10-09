import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultArchiveS3Endpoint,
  MODULE_BANK_ARCHIVE_BACKEND,
  resolveTfBackendMode,
} from '../src/lib/tfBackend';
import { archiveMirrorDriverKindFor } from '../src/services/archiveMirror';

const ENV_KEYS = [
  'GRID_TF_BACKEND',
  'GRID_TF_S3_ENDPOINT',
  'GRID_TF_STATE_REGION',
  'GRID_TF_OCI_NAMESPACE',
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
    delete saved[key];
  }
});

function setEnv(partial: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of Object.keys(partial) as Array<(typeof ENV_KEYS)[number]>) {
    if (!(key in saved)) saved[key] = process.env[key];
    const value = partial[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('tfBackend + archive mirror coverage', () => {
  it('maps every infra module-bank folder to a remote archive driver', () => {
    const infraFolders = [
      'aws',
      'gcp',
      'azure',
      'oracle',
      'alibaba',
      'tencent',
      'huawei',
      'ovh',
      'deutsche-telekom',
      'ibm',
      'ctrls',
      'yotta',
    ];
    for (const folder of infraFolders) {
      const entry = MODULE_BANK_ARCHIVE_BACKEND[folder];
      expect(entry, folder).toBeTruthy();
      expect(entry.mode).not.toBe('local');
      expect(archiveMirrorDriverKindFor(folder)).toBe(entry.mode);
    }
  });

  it('derives archive S3 endpoints for regional clouds', () => {
    expect(
      defaultArchiveS3Endpoint({
        alias: 'tencent',
        mode: 'cos',
        region: 'ap-guangzhou',
      })
    ).toBe('https://cos.ap-guangzhou.myqcloud.com');

    expect(
      defaultArchiveS3Endpoint({
        alias: 'huawei',
        mode: 's3compat',
        region: 'cn-north-1',
      })
    ).toBe('https://obs.cn-north-1.myhuaweicloud.com');

    expect(
      defaultArchiveS3Endpoint({
        alias: 'ovh',
        mode: 's3compat',
        region: 'gra',
      })
    ).toBe('https://s3.gra.io.cloud.ovh.net');

    expect(
      defaultArchiveS3Endpoint({
        alias: 'alibaba',
        mode: 'oss',
        region: 'cn-hangzhou',
      })
    ).toBe('https://oss-cn-hangzhou.aliyuncs.com');

    expect(
      defaultArchiveS3Endpoint({
        alias: 'oracle',
        mode: 'oci',
        region: 'us-ashburn-1',
        ociNamespace: 'mytenancy',
      })
    ).toBe(
      'https://mytenancy.compat.objectstorage.us-ashburn-1.oraclecloud.com'
    );

    // ibm / ctrls need explicit endpoint
    expect(
      defaultArchiveS3Endpoint({ alias: 'ibm', mode: 's3compat', region: 'us-south' })
    ).toBeUndefined();
  });

  it('resolves GRID_TF_BACKEND aliases used with archive mirror', () => {
    setEnv({ GRID_TF_BACKEND: 'tencent' });
    expect(resolveTfBackendMode()).toBe('cos');
    expect(archiveMirrorDriverKindFor('tencent')).toBe('cos');

    setEnv({ GRID_TF_BACKEND: 'huawei' });
    expect(resolveTfBackendMode()).toBe('s3compat');
    expect(archiveMirrorDriverKindFor('huawei')).toBe('s3compat');

    setEnv({ GRID_TF_BACKEND: 'ovh' });
    expect(resolveTfBackendMode()).toBe('s3compat');
  });
});
