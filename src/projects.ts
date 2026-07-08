import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const PROJECT_MARKERS = [".git", "package.json", "pnpm-workspace.yaml", "pyproject.toml", "go.mod", "Cargo.toml"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "vendor"]);

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  root: string;
  markers: string[];
  modifiedAt: string;
  modifiedAtMs: number;
  selectedAt?: string;
};

export type BrowseEntry = {
  name: string;
  path: string;
  isProject: boolean;
  markers: string[];
};

export type BrowseResult = {
  currentPath: string | null;
  parentPath: string | null;
  currentIsProject: boolean;
  currentMarkers: string[];
  entries: BrowseEntry[];
};

type SelectedProjectStore = {
  paths: string[];
};

let selectedPaths = new Set<string>();
let selectedLoaded = false;
let selectedWriteChain = Promise.resolve();

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

function findRoot(projectPath: string): string {
  const root = config.projectRoots.find((item) => isWithinRoot(projectPath, item));
  if (!root) throw new Error("项目路径不在允许范围内");
  return normalizePath(root);
}

function selectedProjectsFile(): string {
  return path.join(config.dataDir, "selected-projects.json");
}

async function persistSelectedProjects(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const payload: SelectedProjectStore = {
    paths: [...selectedPaths].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
  };
  await fs.writeFile(selectedProjectsFile(), JSON.stringify(payload, null, 2), "utf8");
}

function schedulePersistSelectedProjects(): void {
  selectedWriteChain = selectedWriteChain.then(persistSelectedProjects).catch((error) => {
    console.error("保存已选项目失败", error);
  });
}

export async function loadSelectedProjects(): Promise<void> {
  if (selectedLoaded) return;
  selectedLoaded = true;

  try {
    const text = await fs.readFile(selectedProjectsFile(), "utf8");
    const data = JSON.parse(text) as SelectedProjectStore;
    const paths = Array.isArray(data.paths) ? data.paths : [];
    selectedPaths = new Set(
      paths
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => normalizePath(item))
        .filter((item) => config.projectRoots.some((root) => isWithinRoot(item, root))),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    selectedPaths = new Set();
  }
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

async function buildProjectInfo(projectPath: string): Promise<ProjectInfo> {
  const resolved = assertPathAllowed(projectPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("项目路径不是目录");

  const markers = await detectMarkers(resolved);
  if (markers.length === 0) {
    throw new Error("目标目录缺少项目标记，拒绝执行");
  }

  const modified = await getProjectModifiedAt(resolved, markers);
  return {
    id: projectIdFromPath(resolved),
    name: path.basename(resolved),
    path: resolved,
    root: findRoot(resolved),
    markers,
    ...modified,
  };
}

/** 下拉列表只返回已确认加入的项目，不再全盘扫描。 */
export async function listSelectedProjects(): Promise<ProjectInfo[]> {
  await loadSelectedProjects();

  const projects: ProjectInfo[] = [];
  const stalePaths: string[] = [];

  for (const projectPath of selectedPaths) {
    try {
      projects.push(await buildProjectInfo(projectPath));
    } catch {
      stalePaths.push(projectPath);
    }
  }

  if (stalePaths.length > 0) {
    for (const stale of stalePaths) selectedPaths.delete(stale);
    schedulePersistSelectedProjects();
  }

  return projects.sort((a, b) => {
    const timeDiff = b.modifiedAtMs - a.modifiedAtMs;
    if (timeDiff !== 0) return timeDiff;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

/** 确认选择：校验后写入已选项目列表。 */
export async function selectProject(projectPath: string): Promise<ProjectInfo> {
  await loadSelectedProjects();
  const project = await buildProjectInfo(projectPath);
  selectedPaths.add(project.path);
  schedulePersistSelectedProjects();
  return {
    ...project,
    selectedAt: new Date().toISOString(),
  };
}

export async function isProjectSelected(projectId: string): Promise<boolean> {
  await loadSelectedProjects();
  const projectPath = assertPathAllowed(pathFromProjectId(projectId));
  return selectedPaths.has(projectPath);
}

export async function unselectProject(projectId: string): Promise<void> {
  await loadSelectedProjects();
  const projectPath = assertPathAllowed(pathFromProjectId(projectId));
  selectedPaths.delete(projectPath);
  schedulePersistSelectedProjects();
}

export async function getProjectById(projectId: string): Promise<ProjectInfo> {
  return buildProjectInfo(pathFromProjectId(projectId));
}

function isExactRoot(candidate: string): boolean {
  const resolved = normalizeForCompare(candidate);
  return config.projectRoots.some((root) => normalizeForCompare(root) === resolved);
}

function resolveBrowseParent(currentPath: string): string | null {
  if (isExactRoot(currentPath)) return null;
  const parent = normalizePath(path.dirname(currentPath));
  if (parent === currentPath) return null;
  const allowed = config.projectRoots.some((root) => isWithinRoot(parent, root));
  return allowed ? parent : null;
}

async function listDirectoryEntries(dir: string): Promise<BrowseEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error("无法读取该目录");
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  const result: BrowseEntry[] = [];
  for (const entry of directories) {
    const entryPath = normalizePath(path.join(dir, entry.name));
    let markers: string[] = [];
    try {
      markers = await detectMarkers(entryPath);
    } catch {
      markers = [];
    }
    result.push({
      name: entry.name,
      path: entryPath,
      isProject: markers.length > 0,
      markers,
    });
  }

  return result;
}

/** 在 PROJECT_ROOTS 范围内逐级浏览目录，供前端「按目录打开」使用。 */
export async function browseDirectory(rawPath?: string): Promise<BrowseResult> {
  const requested = rawPath?.trim();

  if (!requested) {
    const roots = config.projectRoots.map((root) => normalizePath(root));
    const entries: BrowseEntry[] = [];

    for (const root of roots) {
      let markers: string[] = [];
      try {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) continue;
        markers = await detectMarkers(root);
      } catch {
        continue;
      }

      entries.push({
        name: path.basename(root) || root,
        path: root,
        isProject: markers.length > 0,
        markers,
      });
    }

    return {
      currentPath: null,
      parentPath: null,
      currentIsProject: false,
      currentMarkers: [],
      entries: entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    };
  }

  const currentPath = assertPathAllowed(requested);
  const stat = await fs.stat(currentPath);
  if (!stat.isDirectory()) throw new Error("目标路径不是目录");

  const currentMarkers = await detectMarkers(currentPath);
  return {
    currentPath,
    parentPath: resolveBrowseParent(currentPath),
    currentIsProject: currentMarkers.length > 0,
    currentMarkers,
    entries: await listDirectoryEntries(currentPath),
  };
}
