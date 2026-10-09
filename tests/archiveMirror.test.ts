import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveUnitPrefix,
  deleteUnitArchiveMirror,
  replaceUnitArchiveMirror,
  shouldMirrorArchiveFile,
  type ArchiveMirrorDriver,
} from '../src/services/archiveMirror';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

function memoryDriver(): ArchiveMirrorDriver & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    kind: 's3',
    async probe() {
      /* no-op */
    },
    async list(prefix: string) {
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      return [...store.keys()].filter((k) => k.startsWith(p)).map((key) => ({ key }));
    },
    async put(key: string, body: Buffer) {
      store.set(key, body);
    },
    async deleteKeys(keys: string[]) {
      for (const k of keys) store.delete(k);
    },
  };
}

describe('archiveMirror helpers', () => {
  it('builds unit prefixes under archive/', () => {
    expect(
      archiveUnitPrefix('projects/grid-labs/aws/development/vpc/demo.json')
    ).toBe('archive/projects/grid-labs/aws/development/vpc/demo');
  });

  it('mirrors only .tf and .grid-generated', () => {
    expect(shouldMirrorArchiveFile('main.tf')).toBe(true);
    expect(shouldMirrorArchiveFile('.grid-generated')).toBe(true);
    expect(shouldMirrorArchiveFile('tfplan')).toBe(false);
    expect(shouldMirrorArchiveFile('terraform.tfstate')).toBe(false);
    expect(shouldMirrorArchiveFile('modules/aws/vpc/main.tf')).toBe(true);
  });

  it('replaces a unit folder (delete then upload) without touching siblings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grid-archive-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'main.tf'), 'resource "x" "y" {}\n');
    await fs.writeFile(path.join(dir, '.grid-generated'), '{"v":1}\n');
    await fs.writeFile(path.join(dir, 'tfplan'), 'nope');
    await fs.ensureDir(path.join(dir, '.terraform'));
    await fs.writeFile(path.join(dir, '.terraform', 'x'), 'nope');

    const driver = memoryDriver();
    driver.store.set('archive/other-unit/main.tf', Buffer.from('keep'));
    driver.store.set(
      'archive/projects/demo/aws/dev/vpc/u/main.tf',
      Buffer.from('old')
    );

    const result = await replaceUnitArchiveMirror({
      unitRelPath: 'projects/demo/aws/dev/vpc/u',
      terraformDir: dir,
      driver,
    });

    expect(result.uploaded).toBe(2);
    expect(result.deleted).toBe(1);
    expect(driver.store.has('archive/other-unit/main.tf')).toBe(true);
    expect(
      driver.store.get('archive/projects/demo/aws/dev/vpc/u/main.tf')?.toString()
    ).toContain('resource');
    expect(
      driver.store.has('archive/projects/demo/aws/dev/vpc/u/.grid-generated')
    ).toBe(true);
    expect(driver.store.has('archive/projects/demo/aws/dev/vpc/u/tfplan')).toBe(
      false
    );
  });

  it('deletes only the unit archive subfolder', async () => {
    const driver = memoryDriver();
    driver.store.set('archive/a/b/main.tf', Buffer.from('1'));
    driver.store.set('archive/a/b/.grid-generated', Buffer.from('2'));
    driver.store.set('archive/a/c/main.tf', Buffer.from('3'));

    const result = await deleteUnitArchiveMirror({
      unitRelPath: 'a/b',
      driver,
    });
    expect(result.deleted).toBe(2);
    expect(driver.store.has('archive/a/c/main.tf')).toBe(true);
    expect(driver.store.has('archive/a/b/main.tf')).toBe(false);
  });
});
