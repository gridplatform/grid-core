import path from 'path';
import fs from 'fs-extra';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import {
  DEFAULT_GROUPS,
  defaultCustomGroupPermissions,
  migratePermissionSpec,
  normalizeDomainMap,
  normalizeGrants,
  roleDefaultGroupSlug,
  type DomainPermissionMap,
  type GroupAccessGrant,
  type GroupPermissionSpec,
  type UserRole,
} from '../auth/rbac';
import { listUsers } from './userStore';

export interface GroupRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  system: boolean;
  permissions: GroupPermissionSpec;
  memberUserIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface GroupStoreShape {
  version: 1;
  groups: GroupRecord[];
}

const GROUPS_FILE = () => path.join(config.dataDir, 'groups.json');

let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function empty(): GroupStoreShape {
  return { version: 1, groups: [] };
}

async function readUnlocked(): Promise<GroupStoreShape> {
  await fs.ensureDir(config.dataDir);
  const file = GROUPS_FILE();
  if (!(await fs.pathExists(file))) {
    await fs.writeJSON(file, empty(), { spaces: 2 });
    return empty();
  }
  try {
    const parsed = (await fs.readJSON(file)) as Partial<GroupStoreShape>;
    return {
      version: 1,
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    };
  } catch {
    return empty();
  }
}

async function writeUnlocked(store: GroupStoreShape): Promise<void> {
  const file = GROUPS_FILE();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeJSON(tmp, store, { spaces: 2 });
  await fs.move(tmp, file, { overwrite: true });
}

function normalizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function asPermissionRecord(permissions: GroupPermissionSpec): Record<string, unknown> {
  return permissions as unknown as Record<string, unknown>;
}

/** Ensure built-in groups exist and system membership mirrors each user’s role. */
export async function ensureDefaultGroups(): Promise<GroupRecord[]> {
  return withLock(async () => {
    const store = await readUnlocked();
    const now = new Date().toISOString();
    for (const def of DEFAULT_GROUPS) {
      const existing = store.groups.find((g) => g.slug === def.slug);
      if (!existing) {
        store.groups.push({
          id: def.id,
          slug: def.slug,
          name: def.name,
          description: def.description,
          system: def.system,
          permissions: {
            domains: { ...def.permissions.domains },
            alwaysRequireApprovalForWrite: def.permissions.alwaysRequireApprovalForWrite,
            scope: def.permissions.scope,
          },
          memberUserIds: [],
          createdAt: now,
          updatedAt: now,
        });
      } else {
        existing.system = true;
        existing.permissions = {
          domains: { ...def.permissions.domains },
          alwaysRequireApprovalForWrite: def.permissions.alwaysRequireApprovalForWrite,
          scope: def.permissions.scope,
        };
        existing.description = def.description;
        existing.name = def.name;
      }
    }

    const users = await listUsers();
    for (const g of store.groups) {
      if (!g.system) continue;
      if (!DEFAULT_GROUPS.some((d) => d.slug === g.slug)) continue;
      g.memberUserIds = users
        .filter((u) => {
          const slug = roleDefaultGroupSlug(u.role as UserRole);
          return slug === g.slug && !u.disabled;
        })
        .map((u) => u.id);
      g.updatedAt = now;
    }

    // Migrate legacy custom group shapes → grants model.
    for (const g of store.groups) {
      if (g.system) continue;
      const migrated = migratePermissionSpec(asPermissionRecord(g.permissions));
      g.permissions = migrated;
      g.updatedAt = now;
    }

    await writeUnlocked(store);
    return store.groups;
  });
}

export async function listGroups(): Promise<GroupRecord[]> {
  await ensureDefaultGroups();
  return withLock(async () => (await readUnlocked()).groups);
}

export async function createCustomGroup(input: {
  slug: string;
  name: string;
  description?: string;
  /** Project × environment × domain grants (preferred). */
  grants?: Array<Partial<GroupAccessGrant> | GroupAccessGrant>;
  /** Optional shorthand: domain map applied to projects/environments below. */
  domains?: Partial<DomainPermissionMap>;
  projects?: string[];
  environments?: string[];
  memberUserIds?: string[];
}): Promise<GroupRecord> {
  const slug = normalizeSlug(input.slug);
  if (!slug) throw new Error('Group slug is required');
  if (DEFAULT_GROUPS.some((d) => d.slug === slug)) {
    throw new Error('Cannot create a group that replaces a built-in system group');
  }

  return withLock(async () => {
    const store = await readUnlocked();
    if (store.groups.some((g) => g.slug === slug)) {
      throw new Error(`Group already exists: ${slug}`);
    }
    const now = new Date().toISOString();
    const base = defaultCustomGroupPermissions();

    let grants = normalizeGrants(input.grants);
    if (grants.length === 0 && (input.domains || input.projects || input.environments)) {
      grants = normalizeGrants([
        {
          projects: input.projects,
          environments: input.environments,
          domains: normalizeDomainMap(input.domains),
        },
      ]);
    }
    if (grants.length === 0) {
      grants = base.grants || [];
    }

    const group: GroupRecord = {
      id: uuid(),
      slug,
      name: input.name.trim() || slug,
      description: input.description?.trim() || '',
      system: false,
      permissions: {
        alwaysRequireApprovalForWrite: true,
        scope: 'grants',
        domains: { ...base.domains },
        grants,
      },
      memberUserIds: [...new Set(input.memberUserIds || [])],
      createdAt: now,
      updatedAt: now,
    };
    store.groups.push(group);
    await writeUnlocked(store);
    return group;
  });
}

export async function updateCustomGroupPermissions(
  slug: string,
  patch: {
    grants?: Array<Partial<GroupAccessGrant> | GroupAccessGrant>;
    domains?: Partial<DomainPermissionMap>;
    projects?: string[];
    environments?: string[];
    memberUserIds?: string[];
    name?: string;
    description?: string;
  }
): Promise<GroupRecord> {
  return withLock(async () => {
    const store = await readUnlocked();
    const group = store.groups.find((g) => g.slug === slug);
    if (!group) throw new Error('Group not found');
    if (group.system) throw new Error('Cannot change built-in system group permissions');

    group.permissions.alwaysRequireApprovalForWrite = true;
    group.permissions.scope = 'grants';
    group.permissions.domains = normalizeDomainMap({});

    if (patch.grants) {
      group.permissions.grants = normalizeGrants(patch.grants);
    } else if (patch.domains || patch.projects || patch.environments) {
      group.permissions.grants = normalizeGrants([
        {
          projects: patch.projects,
          environments: patch.environments,
          domains: normalizeDomainMap(patch.domains),
        },
      ]);
    }

    if (patch.memberUserIds) group.memberUserIds = [...new Set(patch.memberUserIds)];
    if (patch.name !== undefined) group.name = patch.name.trim() || group.name;
    if (patch.description !== undefined) group.description = patch.description.trim();
    group.updatedAt = new Date().toISOString();
    await writeUnlocked(store);
    return group;
  });
}
