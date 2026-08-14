import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { formatModelSelection, type AgentModelSelection } from "./models.js";
import type { ProjectInfo } from "./projects.js";

export type JobStatus = "queued" | "running" | "finished" | "error" | "cancelled";

/** Cursor SDK 支持的对话模式 */
export type AgentMode = "agent" | "plan";

export type JobLog = {
  time: string;
  level: "info" | "thinking" | "assistant" | "error";
  message: string;
  turnId?: string;
};

/** 同一任务内的一轮用户指令 */
export type JobTurn = {
  id: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  mode?: AgentMode;
  model?: AgentModelSelection;
  result?: string;
  error?: string;
};

export type JobRecord = {
  id: string;
  project: Pick<ProjectInfo, "id" | "name" | "path">;
  prompt: string;
  promptSummary: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  submittedBy: string;
  sourceIp: string;
  agentId?: string;
  runId?: string;
  /** 旧数据：追加指令曾拆成子任务；加载时会合并进根任务 */
  parentJobId?: string;
  mode?: AgentMode;
  model?: AgentModelSelection;
  result?: string;
  error?: string;
  turns: JobTurn[];
  activeTurnId?: string;
  logs: JobLog[];
};

const jobs = new Map<string, JobRecord>();
let loaded = false;
let writeChain = Promise.resolve();
const MAX_LOG_ENTRIES = 2000;
const MAX_LOG_MESSAGE_LENGTH = 20000;

function jobsFile(): string {
  return path.join(config.dataDir, "jobs.json");
}

function now(): string {
  return new Date().toISOString();
}

function summarizePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 100)}...` : normalized;
}

function createTurn(input: {
  prompt: string;
  mode: AgentMode;
  model?: AgentModelSelection;
  status?: JobStatus;
}): JobTurn {
  return {
    id: crypto.randomUUID(),
    prompt: input.prompt,
    status: input.status ?? "queued",
    createdAt: now(),
    mode: input.mode,
    model: input.model,
  };
}

function describeRunSettings(mode: AgentMode, model?: AgentModelSelection): string {
  const modeText = mode === "plan" ? "Plan" : "Agent";
  const modelText = formatModelSelection(model);
  return modelText ? `${modeText} 模式，${modelText}` : `${modeText} 模式`;
}

async function persist(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const records = [...jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await fs.writeFile(jobsFile(), JSON.stringify(records, null, 2), "utf8");
}

function schedulePersist(): void {
  writeChain = writeChain.then(persist).catch((error) => {
    console.error("保存任务状态失败", error);
  });
}

function ensureJobTurns(job: JobRecord): void {
  if (job.turns?.length) {
    for (const log of job.logs) {
      if (!log.turnId) log.turnId = job.turns[0]?.id;
    }
    return;
  }

  const turn = createTurn({
    prompt: job.prompt,
    mode: job.mode ?? config.cursorDefaultMode,
    model: job.model,
    status: job.status,
  });
  turn.createdAt = job.createdAt;
  turn.startedAt = job.startedAt;
  turn.finishedAt = job.finishedAt;
  turn.result = job.result;
  turn.error = job.error;
  job.turns = [turn];
  job.activeTurnId = turn.id;
  for (const log of job.logs) {
    if (!log.turnId) log.turnId = turn.id;
  }
}

export function syncJobStatusFromTurns(job: JobRecord): void {
  const turns = job.turns ?? [];
  const running = turns.find((turn) => turn.status === "running");
  if (running) {
    job.status = "running";
    job.activeTurnId = running.id;
    job.startedAt = job.startedAt ?? running.startedAt;
    return;
  }

  const queued = turns.find((turn) => turn.status === "queued");
  if (queued) {
    job.status = "queued";
    job.activeTurnId = queued.id;
    job.finishedAt = undefined;
    job.error = undefined;
    return;
  }

  const last = turns.at(-1);
  if (!last) return;
  job.status = last.status;
  job.activeTurnId = last.id;
  job.result = last.result;
  job.error = last.error;
  job.finishedAt = last.finishedAt;
  if (last.mode) job.mode = last.mode;
  if (last.model) job.model = last.model;
}

function migrateConversationChains(): boolean {
  let changed = false;

  for (const job of jobs.values()) {
    const before = job.turns?.length ?? 0;
    ensureJobTurns(job);
    if ((job.turns?.length ?? 0) !== before) changed = true;
  }

  const children = [...jobs.values()]
    .filter((job) => job.parentJobId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const child of children) {
    const rootId = getConversationRootId(child.id);
    const root = jobs.get(rootId);
    if (!root || root.id === child.id) {
      if (child.parentJobId) {
        delete child.parentJobId;
        changed = true;
      }
      continue;
    }

    ensureJobTurns(root);
    ensureJobTurns(child);
    root.turns.push(...child.turns);
    root.logs.push(...child.logs);
    if (child.agentId) root.agentId = child.agentId;
    if (child.runId) root.runId = child.runId;
    if (child.mode) root.mode = child.mode;
    if (child.model) root.model = child.model;
    if (child.startedAt && (!root.startedAt || child.startedAt < root.startedAt)) {
      root.startedAt = child.startedAt;
    }
    syncJobStatusFromTurns(root);
    root.updatedAt = [root.updatedAt, child.updatedAt].sort().at(-1) || now();
    jobs.delete(child.id);
    changed = true;
  }

  return changed;
}

export async function loadJobs(): Promise<void> {
  if (loaded) return;
  loaded = true;

  try {
    const text = await fs.readFile(jobsFile(), "utf8");
    const records = JSON.parse(text) as JobRecord[];
    for (const record of records) jobs.set(record.id, record);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  if (migrateConversationChains()) {
    schedulePersist();
  }
}

export function getConversationRootId(jobId: string): string {
  const seen = new Set<string>();
  let current = jobs.get(jobId);

  while (current?.parentJobId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = jobs.get(current.parentJobId);
    if (!parent) break;
    current = parent;
  }

  return current?.id || jobId;
}

export function getTurn(job: JobRecord, turnId: string): JobTurn | undefined {
  return job.turns.find((turn) => turn.id === turnId);
}

export function nextQueuedTurn(jobId: string): JobTurn | undefined {
  const job = jobs.get(getConversationRootId(jobId));
  return job?.turns.find((turn) => turn.status === "queued");
}

export function cancelQueuedTurns(jobId: string): JobTurn[] {
  const job = jobs.get(getConversationRootId(jobId));
  if (!job) return [];

  const cancelled: JobTurn[] = [];
  for (const turn of job.turns) {
    if (turn.status !== "queued") continue;
    turn.status = "cancelled";
    turn.finishedAt = now();
    turn.error = undefined;
    cancelled.push(turn);
  }

  if (cancelled.length > 0) {
    appendJobLog(job.id, "info", "已取消排队中的后续指令。");
    syncJobStatusFromTurns(job);
    job.updatedAt = now();
    schedulePersist();
  }

  return cancelled;
}

export function listQueuedJobIds(): string[] {
  return [...jobs.values()]
    .filter((job) => !job.parentJobId && job.turns.some((turn) => turn.status === "queued"))
    .map((job) => job.id);
}

/**
 * 进程内存里的 activeRuns 会在重启后丢失，但 jobs.json 里的 running 会原样保留。
 * 启动时把这类孤儿任务标为 error；queued 的后续指令会在启动后继续调度。
 */
export function recoverInterruptedJobs(): number {
  let count = 0;

  for (const job of [...jobs.values()]) {
    let recovered = false;
    for (const turn of job.turns ?? []) {
      if (turn.status !== "running") continue;
      turn.status = "error";
      turn.finishedAt = now();
      turn.error = "服务进程已重启，任务被中断。";
      recovered = true;
    }

    if (job.status === "running" || recovered) {
      appendJobLog(job.id, "error", "服务进程已重启，进行中的任务无法继续，已标记为中断。");
      syncJobStatusFromTurns(job);
      updateJob(job.id, {});
      count += 1;
    }
  }

  return count;
}

export function createJob(input: {
  project: ProjectInfo;
  prompt: string;
  submittedBy: string;
  sourceIp: string;
  mode: AgentMode;
  model?: AgentModelSelection;
}): JobRecord {
  const timestamp = now();
  const turn = createTurn({ prompt: input.prompt, mode: input.mode, model: input.model });
  const job: JobRecord = {
    id: crypto.randomUUID(),
    project: {
      id: input.project.id,
      name: input.project.name,
      path: input.project.path,
    },
    prompt: input.prompt,
    promptSummary: summarizePrompt(input.prompt),
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    submittedBy: input.submittedBy,
    sourceIp: input.sourceIp,
    mode: input.mode,
    model: input.model,
    turns: [turn],
    activeTurnId: turn.id,
    logs: [],
  };

  jobs.set(job.id, job);
  appendJobLog(job.id, "info", `任务已创建（${describeRunSettings(input.mode, input.model)}），等待执行。`, turn.id);
  return job;
}

export function enqueueJobTurn(
  jobId: string,
  input: { prompt: string; mode: AgentMode; model?: AgentModelSelection },
): JobRecord {
  const rootId = getConversationRootId(jobId);
  const job = jobs.get(rootId);
  if (!job) throw new Error("任务不存在");

  ensureJobTurns(job);
  const turn = createTurn({ prompt: input.prompt, mode: input.mode, model: input.model });
  job.turns.push(turn);
  job.mode = input.mode;
  if (input.model) job.model = input.model;
  job.updatedAt = now();
  syncJobStatusFromTurns(job);

  const busy = job.turns.some((item) => item.id !== turn.id && (item.status === "running" || item.status === "queued"));
  appendJobLog(
    job.id,
    "info",
    busy
      ? "已加入排队，当前轮次结束后将自动执行后续指令。"
      : `已追加后续指令（${describeRunSettings(input.mode, input.model)}），等待执行。`,
    turn.id,
  );
  return job;
}

export function listJobs(): JobRecord[] {
  return [...jobs.values()]
    .filter((job) => !job.parentJobId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id) ?? jobs.get(getConversationRootId(id));
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord {
  const job = jobs.get(getConversationRootId(id));
  if (!job) throw new Error("任务不存在");

  Object.assign(job, patch, { updatedAt: now() });
  jobs.set(job.id, job);
  schedulePersist();
  return job;
}

export function updateTurn(jobId: string, turnId: string, patch: Partial<JobTurn>): JobTurn {
  const job = jobs.get(getConversationRootId(jobId));
  if (!job) throw new Error("任务不存在");

  const turn = getTurn(job, turnId);
  if (!turn) throw new Error("对话轮次不存在");

  Object.assign(turn, patch);
  if (patch.mode) job.mode = patch.mode;
  if (patch.model) job.model = patch.model;
  syncJobStatusFromTurns(job);
  job.updatedAt = now();
  schedulePersist();
  return turn;
}

export function appendJobLog(id: string, level: JobLog["level"], message: string, turnId?: string): void {
  const job = jobs.get(getConversationRootId(id));
  if (!job) throw new Error("任务不存在");

  const safeMessage =
    message.length > MAX_LOG_MESSAGE_LENGTH ? `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}\n...日志过长，已截断。` : message;
  const resolvedTurnId = turnId || job.activeTurnId;

  const lastLog = job.logs.at(-1);
  // 流式片段按同类日志合并，便于聊天气泡连续展示
  if (
    (level === "assistant" || level === "thinking") &&
    lastLog?.level === level &&
    lastLog.turnId === resolvedTurnId
  ) {
    const mergedMessage = `${lastLog.message}${safeMessage}`;
    lastLog.message =
      mergedMessage.length > MAX_LOG_MESSAGE_LENGTH
        ? `${mergedMessage.slice(0, MAX_LOG_MESSAGE_LENGTH)}\n...日志过长，已截断。`
        : mergedMessage;
    lastLog.time = now();
  } else {
    job.logs.push({ time: now(), level, message: safeMessage, turnId: resolvedTurnId });
  }

  if (job.logs.length > MAX_LOG_ENTRIES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_ENTRIES);
  }
  job.updatedAt = now();
  schedulePersist();
}
