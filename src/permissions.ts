export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "users.manage",
  "projects.browse",
  "projects.select",
  "projects.useAll",
  "jobs.create",
  "jobs.followUp",
  "jobs.cancel",
  "jobs.viewAll",
  "jobs.operateOthers",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  admin: [...PERMISSIONS],
  operator: ["jobs.create", "jobs.followUp", "jobs.cancel"],
  viewer: ["jobs.viewAll"],
};

const PERMISSION_SET = new Set<string>(PERMISSIONS);
const ROLE_SET = new Set<string>(ROLES);

export function isRole(value: string): value is Role {
  return ROLE_SET.has(value);
}

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export function sanitizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const next: Permission[] = [];
  for (const item of input) {
    const value = String(item || "").trim();
    if (!isPermission(value) || next.includes(value)) continue;
    next.push(value);
  }
  return next;
}

export function resolvePermissions(role: Role, grants: Permission[] = [], denies: Permission[] = []): Permission[] {
  const effective = new Set<Permission>(ROLE_DEFAULTS[role]);
  for (const grant of grants) effective.add(grant);
  for (const deny of denies) effective.delete(deny);
  if (effective.has("jobs.operateOthers")) effective.add("jobs.viewAll");
  return PERMISSIONS.filter((item) => effective.has(item));
}

export function hasPermission(permissions: readonly Permission[] | undefined, permission: Permission): boolean {
  return Boolean(permissions?.includes(permission));
}

export function diffPermissionOverrides(
  role: Role,
  effective: readonly Permission[],
): { grants: Permission[]; denies: Permission[] } {
  const defaults = new Set<Permission>(ROLE_DEFAULTS[role]);
  const next = new Set<Permission>(effective);
  if (next.has("jobs.operateOthers")) next.add("jobs.viewAll");

  const grants = PERMISSIONS.filter((item) => next.has(item) && !defaults.has(item));
  const denies = PERMISSIONS.filter((item) => defaults.has(item) && !next.has(item));
  return { grants, denies };
}

export function publicPermissionCatalog() {
  return {
    permissions: [...PERMISSIONS],
    roles: [...ROLES],
    roleDefaults: ROLE_DEFAULTS,
  };
}
