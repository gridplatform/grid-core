import type { User } from '../types/api';

export type UserRole = User['role'];

/** Persisted user record (includes password hash). */
export interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  disabled: boolean;
}

export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
}

export interface UserStoreShape {
  version: 1;
  users: StoredUser[];
  sessions: SessionRecord[];
}

export function toPublicUser(u: StoredUser): User {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
  };
}
