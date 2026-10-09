import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonOrInit, readJsonSafe, writeJsonAtomic } from '../src/lib/jsonFile';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.remove(d)));
});

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grid-json-'));
  dirs.push(dir);
  return dir;
}

describe('jsonFile', () => {
  it('writes atomically and reads back', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'settings.json');
    await writeJsonAtomic(file, { ok: true, n: 1 });
    const parsed = await readJsonSafe<{ ok: boolean; n: number }>(file);
    expect(parsed).toEqual({ ok: true, n: 1 });
  });

  it('returns null for empty and corrupt files without throwing', async () => {
    const dir = await tmpDir();
    const emptyFile = path.join(dir, 'empty.json');
    const badFile = path.join(dir, 'bad.json');
    await fs.writeFile(emptyFile, '   ');
    await fs.writeFile(badFile, '{not-json');

    expect(await readJsonSafe(emptyFile, { quarantine: false })).toBeNull();
    expect(await readJsonSafe(badFile, { quarantine: true })).toBeNull();
    // corrupt file quarantined
    expect(await fs.pathExists(badFile)).toBe(false);
  });

  it('initializes missing files with fallback', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'init.json');
    const value = await readJsonOrInit(file, { version: 1, items: [] });
    expect(value).toEqual({ version: 1, items: [] });
    expect(await fs.pathExists(file)).toBe(true);
  });
});
