import crypto from "node:crypto";
import { config } from "./config.js";
import { getDb, withTransaction } from "./db.js";
import {
  isRole,
  resolvePermissions,
  sanitizePermissions,
  type Permission,
  type Role,
} from "./permissions.js";

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{2,32}$/;

export type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  grants: Permission[];
  denies: Permission[];
  allowedProjectIds: string[];
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = Omit<UserRecord, "passwordHash"> & {
  permissions: Permission[];
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  grants_json: string;
  denies_json: string;
  disabled: number;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

export function normalizeUsername(username: string): string {
  return username.trim();
}

export function assertUsername(username: string): string {
  const next = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(next)) {
    throw new Error("用户名需为 2-32 位字母、数字、点、下划线或连字符");
  }
  return next;
}

function parseJsonArray(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function listUserProjectIds(userId: string): string[] {
  const rows = getDb()
    .prepare("SELECT project_id FROM user_projects WHERE user_id = ? ORDER BY project_id")
    .all(userId) as Array<{ project_id: string }>;
  return rows.map((row) => row.project_id);
}

function replaceUserProjects(userId: string, projectIds: string[]): void {
  const db = getDb();
  db.prepare("DELETE FROM user_projects WHERE user_id = ?").run(userId);
  const insert = db.prepare("INSERT INTO user_projects (user_id, project_id) VALUES (?, ?)");
  const unique = [...new Set(projectIds.map((item) => String(item || "").trim()).filter(Boolean))];
  for (const projectId of unique) {
    insert.run(userId, projectId);
  }
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: isRole(row.role) ? row.role : "viewer",
    grants: sanitizePermissions(parseJsonArray(row.grants_json)),
    denies: sanitizePermissions(parseJsonArray(row.denies_json)),
    allowedProjectIds: listUserProjectIds(row.id),
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    grants: user.grants,
    denies: user.denies,
    allowedProjectIds: user.allowedProjectIds,
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    permissions: resolvePermissions(user.role, user.grants, user.denies),
  };
}

export function countUsers(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return Number(row.count || 0);
}

export function countActiveAdmins(exceptUserId?: string): number {
  if (exceptUserId) {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
      .get(exceptUserId) as { count: number };
    return Number(row.count || 0);
  }
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0")
    .get() as { count: number };
  return Number(row.count || 0);
}

export function hasActiveAdmin(): boolean {
  return countActiveAdmins() > 0;
}

export function listUsers(): PublicUser[] {
  const rows = getDb().prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE").all() as UserRow[];
  return rows.map((row) => toPublicUser(mapUser(row)));
}

export function getUserById(id: string): UserRecord | undefined {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? mapUser(row) : undefined;
}

export function getUserByUsername(username: string): UserRecord | undefined {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .get(normalizeUsername(username)) as UserRow | undefined;
  return row ? mapUser(row) : undefined;
}

function insertUserRow(user: UserRecord): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, grants_json, denies_json, disabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      user.username,
      user.passwordHash,
      user.role,
      JSON.stringify(user.grants),
      JSON.stringify(user.denies),
      user.disabled ? 1 : 0,
      user.createdAt,
      user.updatedAt,
    );
  replaceUserProjects(user.id, user.allowedProjectIds);
}

export function createUser(input: {
  username: string;
  passwordHash: string;
  role: Role;
  grants?: Permission[];
  denies?: Permission[];
  allowedProjectIds?: string[];
  disabled?: boolean;
}): UserRecord {
  const username = assertUsername(input.username);
  if (getUserByUsername(username)) {
    throw new Error("用户名已存在");
  }

  const timestamp = now();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    passwordHash: input.passwordHash,
    role: input.role,
    grants: sanitizePermissions(input.grants),
    denies: sanitizePermissions(input.denies),
    allowedProjectIds: [...new Set((input.allowedProjectIds ?? []).filter(Boolean))],
    disabled: Boolean(input.disabled),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  withTransaction(() => insertUserRow(user));
  return getUserById(user.id) ?? user;
}

export function updateUser(
  id: string,
  patch: {
    role?: Role;
    grants?: Permission[];
    denies?: Permission[];
    allowedProjectIds?: string[];
    disabled?: boolean;
    passwordHash?: string;
  },
): UserRecord {
  const current = getUserById(id);
  if (!current) throw new Error("用户不存在");

  const nextRole = patch.role ?? current.role;
  const nextDisabled = patch.disabled ?? current.disabled;
  if (current.role === "admin" && !current.disabled && (nextRole !== "admin" || nextDisabled)) {
    if (countActiveAdmins(current.id) === 0) {
      throw new Error("不能停用或降级最后一名管理员");
    }
  }

  const updated: UserRecord = {
    ...current,
    role: nextRole,
    grants: patch.grants !== undefined ? sanitizePermissions(patch.grants) : current.grants,
    denies: patch.denies !== undefined ? sanitizePermissions(patch.denies) : current.denies,
    allowedProjectIds: patch.allowedProjectIds !== undefined ? [...new Set(patch.allowedProjectIds.filter(Boolean))] : current.allowedProjectIds,
    disabled: nextDisabled,
    passwordHash: patch.passwordHash ?? current.passwordHash,
    updatedAt: now(),
  };

  withTransaction(() => {
    getDb()
      .prepare(
        `UPDATE users
         SET password_hash = ?, role = ?, grants_json = ?, denies_json = ?, disabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.passwordHash,
        updated.role,
        JSON.stringify(updated.grants),
        JSON.stringify(updated.denies),
        updated.disabled ? 1 : 0,
        updated.updatedAt,
        updated.id,
      );
    if (patch.allowedProjectIds !== undefined) {
      replaceUserProjects(updated.id, updated.allowedProjectIds);
    }
  });

  return getUserById(id) ?? updated;
}

export function addUserProject(userId: string, projectId: string): void {
  if (!getUserById(userId)) return;
  getDb()
    .prepare("INSERT OR IGNORE INTO user_projects (user_id, project_id) VALUES (?, ?)")
    .run(userId, projectId);
}

export function removeProjectFromAllUsers(projectId: string): void {
  getDb().prepare("DELETE FROM user_projects WHERE project_id = ?").run(projectId);
}

export function upsertAdminUser(username: string, passwordHash: string): UserRecord {
  const normalized = assertUsername(username);
  const existing = getUserByUsername(normalized);
  if (existing) {
    return updateUser(existing.id, {
      role: "admin",
      disabled: false,
      passwordHash,
    });
  }
  return createUser({
    username: normalized,
    passwordHash,
    role: "admin",
  });
}

export function bootstrapAdminFromEnv(): UserRecord | undefined {
  if (countUsers() > 0) return undefined;
  if (!config.adminPasswordHash) return undefined;
  const username = normalizeUsername(config.adminUsername) || "admin";
  return createUser({
    username: USERNAME_PATTERN.test(username) ? username : "admin",
    passwordHash: config.adminPasswordHash,
    role: "admin",
  });
}

export function assertHasActiveAdmin(): void {
  if (hasActiveAdmin()) return;
  throw new Error("没有可用的管理员。请先复制 .env.example 为 .env，并运行 pnpm init-admin。");
}
