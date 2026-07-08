import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const PROJECT_MARKERS = [".git", "package.json", "pnpm-workspace.yaml", "pyproject.toml", "go.mod", "Cargo.toml"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "vendor"]);
const MAX_SCAN_DEPTH = 4;

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  root: string;
  markers: string[];
  modifiedAt: string;
  modifiedAtMs: number;
};

function normalizePath(value: string): string {
  return path.resolve(value);
}

function normalizeForCompare(value: string): string {
  return normalizePath(value).toLowerCase();
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = normalizeForCompare(candidate);
  const resolvedRoot = normalizeForCompare(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function projectIdFromPath(projectPath: string): string {
  return Buffer.from(normalizePath(projectPath), "utf8").toString("base64url");
}

export function pathFromProjectId(projectId: string): string {
  return Buffer.from(projectId, "base64url").toString("utf8");
}

export function assertPathAllowed(projectPath: string): string {
  const resolved = normalizePath(projectPath);
  const allowed = config.projectRoots.some((root) => isWithinRoot(resolved, root));

  if (!allowed) {
    throw new Error("项目路径不在允许的本地项目根目录内");
  }

  return resolved;
}

async function detectMarkers(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  return PROJECT_MARKERS.filter((marker) => names.has(marker));
}

async function getProjectModifiedAt(dir: string, markers: string[]): Promise<{ modifiedAt: string; modifiedAtMs: number }> {
  const stats = await Promise.allSettled([fs.stat(dir), ...markers.map((marker) => fs.stat(path.join(dir, marker)))]);
  const modifiedAtMs = stats.reduce((latest, item) => {
    if (item.status !== "fulfilled") return latest;
    return Math.max(latest, item.value.mtimeMs);
  }, 0);

  return {
    modifiedAt: new Date(modifiedAtMs || Date.now()).toISOString(),
    modifiedAtMs,
  };
}

async function scanDir(dir: string, root: string, depth: number, result: Map<string, ProjectInfo>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const markers = PROJECT_MARKERS.filter((marker) => entries.some((entry) => entry.name === marker));
  if (markers.length > 0) {
    const resolved = normalizePath(dir);
    const modified = await getProjectModifiedAt(resolved, markers);
    result.set(resolved, {
      id: projectIdFromPath(resolved),
      name: path.basename(resolved),
      path: resolved,
      root,
      markers,
      ...modified,
    });

    // 已经识别为项目后，不继续深入扫描它的内部依赖目录。
    if (markers.includes(".git")) return;
  }

  if (depth >= MAX_SCAN_DEPTH) return;

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      .map((entry) => scanDir(path.join(dir, entry.name), root, depth + 1, result)),
  );
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const result = new Map<string, ProjectInfo>();

  for (const root of config.projectRoots) {
    const resolvedRoot = normalizePath(root);
    await scanDir(resolvedRoot, resolvedRoot, 0, result);
  }

  return [...result.values()].sort((a, b) => {
    const timeDiff = b.modifiedAtMs - a.modifiedAtMs;
    if (timeDiff !== 0) return timeDiff;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

export async function getProjectById(projectId: string): Promise<ProjectInfo> {
  const projectPath = assertPathAllowed(pathFromProjectId(projectId));
  const stat = await fs.stat(projectPath);
  if (!stat.isDirectory()) throw new Error("项目路径不是目录");

  const markers = await detectMarkers(projectPath);
  if (markers.length === 0) {
    throw new Error("目标目录缺少项目标记，拒绝执行");
  }
  const modified = await getProjectModifiedAt(projectPath, markers);

  const root = config.projectRoots.find((item) => isWithinRoot(projectPath, item));
  if (!root) throw new Error("项目路径不在允许范围内");

  return {
    id: projectIdFromPath(projectPath),
    name: path.basename(projectPath),
    path: projectPath,
    root,
    markers,
    ...modified,
  };
}
