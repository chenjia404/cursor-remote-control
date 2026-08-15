import { hasPermission, type Permission } from "./permissions.js";

export type AccessUser = {
  username: string;
  permissions: Permission[];
  allowedProjectIds: string[];
};

export function userCanUseProject(user: AccessUser | undefined, projectId: string): boolean {
  if (!user) return false;
  if (hasPermission(user.permissions, "projects.useAll")) return true;
  return user.allowedProjectIds.includes(projectId);
}

export function userCanViewJob(user: AccessUser | undefined, submittedBy: string): boolean {
  if (!user) return false;
  if (hasPermission(user.permissions, "jobs.viewAll")) return true;
  return submittedBy === user.username;
}

export function userCanOperateJob(
  user: AccessUser | undefined,
  submittedBy: string,
  permission: "jobs.followUp" | "jobs.cancel",
): boolean {
  if (!user || !hasPermission(user.permissions, permission)) return false;
  if (submittedBy === user.username) return true;
  return hasPermission(user.permissions, "jobs.operateOthers");
}

export function userCanViewSchedule(user: AccessUser | undefined, ownerUsername: string): boolean {
  return userCanViewJob(user, ownerUsername);
}

export function userCanManageSchedule(user: AccessUser | undefined, ownerUsername: string): boolean {
  if (!user || !hasPermission(user.permissions, "jobs.create")) return false;
  if (ownerUsername === user.username) return true;
  return hasPermission(user.permissions, "jobs.operateOthers");
}
