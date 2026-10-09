import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { readJsonSafe, writeJsonAtomic } from '../lib/jsonFile';
import type { SessionRecord, StoredUser, UserStoreShape } from '../auth/types';

const USERS_FILE = () => path.join(config.dataDir, 'users.json');

let storeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeChain.then(fn, fn);
  storeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function emptyStore(): UserStoreShape {
  return { version: 1, users: [], sessions: [] };
}

async function readUnlocked(): Promise<UserStoreShape> {
  await fs.ensureDir(config.dataDir);
  const file = USERS_FILE();
  const parsed = await readJsonSafe<Partial<UserStoreShape>>(file, {
    label: 'users.json',
  });
  if (!parsed) {
    const empty = emptyStore();
    await writeJsonAtomic(file, empty);
    return empty;
  }
  return {
    version: 1,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}

async function writeUnlocked(store: UserStoreShape): Promise<void> {
  await fs.ensureDir(config.dataDir);
  await writeJsonAtomic(USERS_FILE(), store);
}

export async function readUserStore(): Promise<UserStoreShape> {
  return withLock(() => readUnlocked());
}

export async function mutateUserStore<T>(
  mutator: (store: UserStoreShape) => T | Promise<T>
): Promise<T> {
  return withLock(async () => {
    const store = await readUnlocked();
    const result = await mutator(store);
    await writeUnlocked(store);
    return result;
  });
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(email: string): Promise<StoredUser | undefined> {
  const norm = normalizeEmail(email);
  const store = await readUserStore();
  return store.users.find((u) => normalizeEmail(u.email) === norm);
}

export async function findUserById(id: string): Promise<StoredUser | undefined> {
  const store = await readUserStore();
  return store.users.find((u) => u.id === id);
}

export async function listUsers(): Promise<StoredUser[]> {
  const store = await readUserStore();
  return [...store.users].sort((a, b) => a.email.localeCompare(b.email));
}

export async function insertUser(
  input: Omit<StoredUser, 'id' | 'createdAt' | 'updatedAt'>
): Promise<StoredUser> {
  const now = new Date().toISOString();
  const user: StoredUser = {
    ...input,
    id: uuid(),
    email: normalizeEmail(input.email),
    createdAt: now,
    updatedAt: now,
  };
  await mutateUserStore((store) => {
    if (store.users.some((u) => normalizeEmail(u.email) === user.email)) {
      throw new Error('email_taken');
    }
    store.users.push(user);
  });
  return user;
}

export async function updateUser(
  id: string,
  patch: Partial<Pick<StoredUser, 'name' | 'role' | 'disabled' | 'passwordHash'>>
): Promise<StoredUser | undefined> {
  let updated: StoredUser | undefined;
  await mutateUserStore((store) => {
    const idx = store.users.findIndex((u) => u.id === id);
    if (idx < 0) return;
    const next = {
      ...store.users[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    store.users[idx] = next;
    updated = next;
  });
  return updated;
}

export async function createSession(userId: string, expiresAt: string): Promise<SessionRecord> {
  const token = uuid().replace(/-/g, '') + uuid().replace(/-/g, '');
  const session: SessionRecord = {
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  await mutateUserStore((store) => {
    store.sessions.push(session);
  });
  return session;
}

export async function deleteSession(token: string): Promise<void> {
  await mutateUserStore((store) => {
    store.sessions = store.sessions.filter((s) => s.token !== token);
  });
}

export async function findSession(token: string): Promise<SessionRecord | undefined> {
  const store = await readUserStore();
  const session = store.sessions.find((s) => s.token === token);
  if (!session) return undefined;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await deleteSession(token);
    return undefined;
  }
  return session;
}

export async function touchSession(token: string): Promise<void> {
  const now = new Date().toISOString();
  await mutateUserStore((store) => {
    const s = store.sessions.find((x) => x.token === token);
    if (s) s.lastUsedAt = now;
  });
}

export async function purgeExpiredSessions(): Promise<number> {
  const now = Date.now();
  let removed = 0;
  await mutateUserStore((store) => {
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((s) => new Date(s.expiresAt).getTime() > now);
    removed = before - store.sessions.length;
  });
  return removed;
}

export async function userCount(): Promise<number> {
  const store = await readUserStore();
  return store.users.length;
}
