/**
 * Mirror generated instance Terraform (archive/) into the same object store
 * used for remote Terraform state — under the `archive/` prefix.
 *
 * Local GRID_CONFIG_ROOT/archive/ remains the working copy; the bucket is a
 * durable exit buffer so operators keep their .tf if they leave Grid.
 */
import path from 'node:path';
import fs from 'fs-extra';
import {
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import {
  defaultArchiveS3Endpoint,
  MODULE_BANK_ARCHIVE_BACKEND,
  resolveTfBackendMode,
  type TfBackendMode,
} from '../lib/tfBackend';

export type ArchiveMirrorMode = Exclude<TfBackendMode, 'local'>;

const ARCHIVE_ROOT = 'archive';

/** Re-export for callers / tests — module-bank → archive backend coverage. */
export { MODULE_BANK_ARCHIVE_BACKEND };

/** Files we mirror (instance HCL + marker). Modules stay remote/public. */
export function shouldMirrorArchiveFile(name: string): boolean {
  const base = path.basename(name);
  if (base === '.grid-generated') return true;
  if (base.endsWith('.tf')) return true;
  return false;
}

/** Object prefix for one unit: archive/<unitRel>/ */
export function archiveUnitPrefix(unitRelPath: string): string {
  const rel = unitRelPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.json$/i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return `${ARCHIVE_ROOT}/${rel}`;
}

export function isArchiveMirrorEnabled(): boolean {
  return resolveTfBackendMode() !== 'local';
}

type ListedObject = { key: string };

export interface ArchiveMirrorDriver {
  kind: ArchiveMirrorMode;
  probe(): Promise<void>;
  list(prefix: string): Promise<ListedObject[]>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  deleteKeys(keys: string[]): Promise<void>;
}

function requireEnv(name: string): string {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`${name} is required for archive mirror`);
  return v;
}

type S3LikeMode = 's3' | 'oss' | 'oci' | 'cos' | 's3compat';

function s3ClientForMode(mode: S3LikeMode): S3Client {
  const region =
    (process.env.GRID_TF_STATE_REGION || '').trim() ||
    process.env.AWS_REGION ||
    'us-east-1';
  const endpoint = defaultArchiveS3Endpoint({ mode, region });
  const forcePathStyle =
    process.env.GRID_TF_S3_FORCE_PATH_STYLE === '1' ||
    process.env.GRID_TF_S3_FORCE_PATH_STYLE === 'true' ||
    mode === 'oss' ||
    mode === 'oci' ||
    mode === 'cos' ||
    mode === 's3compat';

  // Non-AWS object stores: need an S3-compatible endpoint (env or derived).
  if (mode !== 's3' && !endpoint) {
    throw new Error(
      `GRID_TF_BACKEND=${process.env.GRID_TF_BACKEND || mode} archive mirror requires ` +
        `GRID_TF_S3_ENDPOINT (or GRID_TF_STATE_REGION for huawei/ovh/otc/tencent/alibaba, ` +
        `plus GRID_TF_OCI_NAMESPACE for oracle)`
    );
  }

  return new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle } : {}),
  });
}

function createS3LikeDriver(mode: S3LikeMode): ArchiveMirrorDriver {
  const bucket = requireEnv('GRID_TF_STATE_BUCKET');
  const client = s3ClientForMode(mode);

  return {
    kind: mode,
    async probe() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      const probeKey = `${ARCHIVE_ROOT}/.grid-archive-probe`;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: probeKey,
          Body: Buffer.from(`grid-archive-probe ${new Date().toISOString()}\n`),
          ContentType: 'text/plain',
        })
      );
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: [{ Key: probeKey }], Quiet: true },
        })
      );
    },
    async list(prefix: string) {
      const keys: ListedObject[] = [];
      let token: string | undefined;
      const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
      do {
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: normalized,
            ContinuationToken: token,
          })
        );
        for (const obj of out.Contents || []) {
          if (obj.Key) keys.push({ key: obj.Key });
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async put(key: string, body: Buffer, contentType?: string) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType || 'application/octet-stream',
        })
      );
    },
    async deleteKeys(keys: string[]) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        if (!chunk.length) continue;
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: chunk.map((Key) => ({ Key })),
              Quiet: true,
            },
          })
        );
      }
    },
  };
}

function createGcsDriver(): ArchiveMirrorDriver {
  const bucketName = requireEnv('GRID_TF_STATE_BUCKET');
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  return {
    kind: 'gcs',
    async probe() {
      const [exists] = await bucket.exists();
      if (!exists) throw new Error(`GCS bucket not found: ${bucketName}`);
      const probeKey = `${ARCHIVE_ROOT}/.grid-archive-probe`;
      const file = bucket.file(probeKey);
      await file.save(`grid-archive-probe ${new Date().toISOString()}\n`, {
        contentType: 'text/plain',
        resumable: false,
      });
      await file.delete({ ignoreNotFound: true });
    },
    async list(prefix: string) {
      const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const [files] = await bucket.getFiles({ prefix: normalized });
      return files.map((f) => ({ key: f.name }));
    },
    async put(key: string, body: Buffer, contentType?: string) {
      await bucket.file(key).save(body, {
        contentType: contentType || 'application/octet-stream',
        resumable: false,
      });
    },
    async deleteKeys(keys: string[]) {
      await Promise.all(
        keys.map((key) => bucket.file(key).delete({ ignoreNotFound: true }))
      );
    },
  };
}

function createAzureDriver(): ArchiveMirrorDriver {
  const account = requireEnv('GRID_TF_AZURE_STORAGE_ACCOUNT');
  const containerName = requireEnv('GRID_TF_AZURE_CONTAINER');
  const cred = new DefaultAzureCredential();
  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    cred
  );
  const container = service.getContainerClient(containerName);

  return {
    kind: 'azurerm',
    async probe() {
      const exists = await container.exists();
      if (!exists) {
        throw new Error(`Azure container not found: ${containerName}`);
      }
      const probeKey = `${ARCHIVE_ROOT}/.grid-archive-probe`;
      const blob = container.getBlockBlobClient(probeKey);
      const body = Buffer.from(`grid-archive-probe ${new Date().toISOString()}\n`);
      await blob.uploadData(body, {
        blobHTTPHeaders: { blobContentType: 'text/plain' },
      });
      await blob.deleteIfExists();
    },
    async list(prefix: string) {
      const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const keys: ListedObject[] = [];
      for await (const item of container.listBlobsFlat({ prefix: normalized })) {
        keys.push({ key: item.name });
      }
      return keys;
    },
    async put(key: string, body: Buffer, contentType?: string) {
      const blob = container.getBlockBlobClient(key);
      await blob.uploadData(body, {
        blobHTTPHeaders: {
          blobContentType: contentType || 'application/octet-stream',
        },
      });
    },
    async deleteKeys(keys: string[]) {
      await Promise.all(
        keys.map((key) => container.getBlockBlobClient(key).deleteIfExists())
      );
    },
  };
}

/**
 * Driver for the configured remote store. Uses the same mode resolution as
 * Terraform state backends (including module-bank aliases: tencent→cos,
 * huawei→s3compat, ovh→s3compat, …).
 */
export function createArchiveMirrorDriver(
  mode: TfBackendMode = resolveTfBackendMode()
): ArchiveMirrorDriver {
  if (mode === 'local') {
    throw new Error('archive mirror requires a remote GRID_TF_BACKEND');
  }
  if (
    mode === 's3' ||
    mode === 'oss' ||
    mode === 'oci' ||
    mode === 'cos' ||
    mode === 's3compat'
  ) {
    return createS3LikeDriver(mode);
  }
  if (mode === 'gcs') return createGcsDriver();
  if (mode === 'azurerm') return createAzureDriver();
  throw new Error(`Unsupported archive mirror backend: ${mode}`);
}

/** Which archive driver kind a GRID_TF_BACKEND alias resolves to (no I/O). */
export function archiveMirrorDriverKindFor(
  backendAlias: string
): ArchiveMirrorMode | 'local' {
  const mode = resolveTfBackendMode(backendAlias);
  return mode === 'local' ? 'local' : mode;
}

async function collectLocalMirrorFiles(
  terraformDir: string
): Promise<Array<{ abs: string; rel: string }>> {
  const out: Array<{ abs: string; rel: string }> = [];
  if (!(await fs.pathExists(terraformDir))) return out;

  const walk = async (dir: string, relBase: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const name = ent.name;
      if (name === '.terraform' || name === 'modules') continue;
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      if (ent.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!shouldMirrorArchiveFile(name)) continue;
      out.push({ abs, rel: rel.replace(/\\/g, '/') });
    }
  };

  await walk(terraformDir, '');
  return out;
}

function contentTypeFor(rel: string): string {
  if (rel.endsWith('.tf')) return 'text/plain; charset=utf-8';
  if (rel.endsWith('.grid-generated')) return 'application/json';
  return 'application/octet-stream';
}

export type MirrorReplaceResult = {
  prefix: string;
  uploaded: number;
  deleted: number;
};

/**
 * Replace one unit's remote archive folder: delete existing objects under
 * archive/<unit>/ then upload current .tf + .grid-generated from disk.
 */
export async function replaceUnitArchiveMirror(opts: {
  unitRelPath: string;
  terraformDir: string;
  driver?: ArchiveMirrorDriver;
  log?: (line: string) => Promise<void> | void;
}): Promise<MirrorReplaceResult> {
  const driver = opts.driver || createArchiveMirrorDriver();
  const prefix = archiveUnitPrefix(opts.unitRelPath);
  const log = opts.log || (() => undefined);

  const existing = await driver.list(prefix);
  if (existing.length) {
    await driver.deleteKeys(existing.map((o) => o.key));
    await log(
      `[grid] archive mirror: removed ${existing.length} object(s) under ${prefix}/`
    );
  }

  const files = await collectLocalMirrorFiles(opts.terraformDir);
  for (const file of files) {
    const body = await fs.readFile(file.abs);
    const key = `${prefix}/${file.rel}`;
    await driver.put(key, body, contentTypeFor(file.rel));
  }
  await log(
    `[grid] archive mirror: uploaded ${files.length} file(s) → ${prefix}/ (${driver.kind})`
  );

  return { prefix, uploaded: files.length, deleted: existing.length };
}

/** Delete only archive/<unit>/… — never the whole archive/ tree. */
export async function deleteUnitArchiveMirror(opts: {
  unitRelPath: string;
  driver?: ArchiveMirrorDriver;
  log?: (line: string) => Promise<void> | void;
}): Promise<{ prefix: string; deleted: number }> {
  const driver = opts.driver || createArchiveMirrorDriver();
  const prefix = archiveUnitPrefix(opts.unitRelPath);
  const log = opts.log || (() => undefined);
  const existing = await driver.list(prefix);
  if (existing.length) {
    await driver.deleteKeys(existing.map((o) => o.key));
  }
  await log(
    `[grid] archive mirror: deleted unit folder ${prefix}/ (${existing.length} object(s), ${driver.kind})`
  );
  return { prefix, deleted: existing.length };
}

/**
 * Production hard gate: prove the state bucket/container is reachable and that
 * the archive/ prefix is writable (put + delete probe object).
 */
export async function assertArchiveMirrorReady(): Promise<void> {
  if (!isArchiveMirrorEnabled()) {
    throw new Error(
      'archive mirror requires GRID_TF_BACKEND=s3|gcs|azurerm|oci|oss|cos|s3compat (not local)'
    );
  }
  try {
    const driver = createArchiveMirrorDriver();
    await driver.probe();
    console.log(
      `[grid-core] archive mirror OK — backend=${driver.kind} prefix=${ARCHIVE_ROOT}/`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[grid-core] production boot refused — archive mirror not accessible\n` +
        `  GRID_TF_BACKEND=${process.env.GRID_TF_BACKEND || '(unset)'}\n` +
        `  detail: ${msg}\n` +
        `  fix: grant the Grid host IAM to List/Get/Put/Delete on the state bucket ` +
        `under the archive/ prefix (same store as Terraform state).\n` +
        `  For oss/oci/s3compat (and optional cos) set GRID_TF_S3_ENDPOINT to the S3-compatible API URL.`
    );
  }
}
