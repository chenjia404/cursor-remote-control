import type { SettingSource, ToolName } from "@cursor/sdk";
import { config } from "./config.js";
import {
  assertPathAllowed,
  getProjectById,
  isProjectSelected,
  type ProjectInfo,
} from "./projects.js";

export const DISALLOWABLE_TOOLS = [
  "shell",
  "mcp",
  "webSearch",
  "webFetch",
  "generateImage",
  "task",
  "delete",
  "edit",
] as const;

const KNOWN_TOOLS = new Set<string>([
  "shell",
  "read",
  "edit",
  "grep",
  "glob",
  "ls",
  "task",
  "mcp",
  "webSearch",
  "delete",
  "readLints",
  "webFetch",
  "semSearch",
  "updateTodos",
  "readTodos",
  "askQuestion",
  "await",
  "generateImage",
  "applyAgentDiff",
  ...DISALLOWABLE_TOOLS,
]);

const MAX_EXTRA_WORKSPACES = 8;

export type ExtraProjectRef = Pick<ProjectInfo, "id" | "name" | "path">;

export type AgentRunOptions = {
  loadLocalSettings: boolean;
  sandbox: boolean;
  autoReview: boolean;
  disallowedTools: ToolName[];
  extraProjects: ExtraProjectRef[];
};

export function sanitizeToolNames(input: unknown): ToolName[] {
  if (!Array.isArray(input)) return [];
  const next: ToolName[] = [];
  for (const item of input.slice(0, 32)) {
    const name = String(item || "").trim();
    if (!KNOWN_TOOLS.has(name)) continue;
    if (!next.includes(name as ToolName)) next.push(name as ToolName);
  }
  return next;
}

export function mergeDisallowedTools(jobTools: ToolName[] | undefined): ToolName[] | undefined {
  const merged = [...new Set([...config.cursorDisallowedTools, ...(jobTools ?? [])])];
  return merged.length ? merged : undefined;
}

export function normalizeBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  return fallback;
}

export async function resolveExtraProjects(
  projectIds: unknown,
  primaryProjectId: string,
): Promise<ExtraProjectRef[]> {
  if (!Array.isArray(projectIds)) return [];

  const extra: ExtraProjectRef[] = [];
  const seen = new Set<string>([primaryProjectId]);

  for (const rawId of projectIds.slice(0, MAX_EXTRA_WORKSPACES)) {
    const projectId = String(rawId || "").trim();
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);

    if (!(await isProjectSelected(projectId))) {
      throw new Error("附加工作区必须是已确认的项目");
    }

    const project = await getProjectById(projectId);
    extra.push({ id: project.id, name: project.name, path: project.path });
  }

  return extra;
}

export function extraWorkspacePaths(extraProjects: ExtraProjectRef[] | undefined): string[] {
  const paths: string[] = [];
  for (const project of extraProjects ?? []) {
    try {
      paths.push(assertPathAllowed(project.path));
    } catch {
      console.warn(`附加工作区已跳过（不在允许范围内）：${project.name}`);
    }
  }
  return paths;
}

export function resolveRunOptions(input: {
  loadLocalSettings?: unknown;
  sandbox?: unknown;
  autoReview?: unknown;
  disallowedTools?: unknown;
  extraProjects?: ExtraProjectRef[];
}): AgentRunOptions {
  return {
    loadLocalSettings: normalizeBoolean(input.loadLocalSettings, true),
    sandbox: normalizeBoolean(input.sandbox, config.cursorSandbox),
    autoReview: normalizeBoolean(input.autoReview, config.cursorAutoReview),
    disallowedTools: sanitizeToolNames(input.disallowedTools),
    extraProjects: input.extraProjects ?? [],
  };
}

export function settingSourcesForRun(loadLocalSettings: boolean): SettingSource[] {
  return loadLocalSettings ? config.cursorSettingSources : [];
}

export function publicAgentOptionDefaults() {
  return {
    settingSources: config.cursorSettingSources,
    sandbox: config.cursorSandbox,
    autoReview: config.cursorAutoReview,
    disallowedTools: config.cursorDisallowedTools,
    disallowableTools: [...DISALLOWABLE_TOOLS],
  };
}
