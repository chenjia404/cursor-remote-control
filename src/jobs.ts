import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ToolName } from "@cursor/sdk";
import type { ExtraProjectRef } from "./agentOptions.js";
import { config } from "./config.js";
import type { JobImageMeta } from "./jobImages.js";
import { formatModelSelection, type AgentModelSelection } from "./models.js";
import type { ProjectInfo } from "./projects.js";

export type JobStatus = "queued" | "running" | "finished" | "error" | "cancelled";

/** Cursor SDK 支持的对话模式 */
export type AgentMode = "agent" | "plan";

/** 后续指令投递：排队等当前轮结束，或中断当前轮立刻执行 */
export type FollowUpDelivery = "queue" | "interrupt";

export type JobLogLevel = "info" | "thinking" | "assistant" | "error" | "tool" | "status";

export type JobLog = {
  time: string;
  level: JobLogLevel;
  message: string;
  turnId?: string;
  source?: string;
};

export type JobTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
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
  /** 中断投递的轮次启动时会强制结束残留 Run */
  delivery?: FollowUpDelivery;
  images?: JobImageMeta[];
  loadLocalSettings?: boolean;
  sandbox?: boolean;
  autoReview?: boolean;
  disallowedTools?: ToolName[];
  usage?: JobTokenUsage;
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
  extraProjects?: ExtraProjectRef[];
  loadLocalSettings?: boolean;
  sandbox?: boolean;
  autoReview?: boolean;
  disallowedTools?: ToolName[];
  usage?: JobTokenUsage;
  activeTurnId?: string;
  logs: JobLog[];
};

export type JobTurnSummary = Pick<JobTurn, "id" | "status" | "createdAt" | "startedAt" | "finishedAt" | "mode">;

/** 历史列表用的瘦身结构，不含日志和完整指令正文 */
export type JobSummary = {
  id: string;
  project: JobRecord["project"];
  promptSummary: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  mode?: AgentMode;
  model?: AgentModelSelection;
  extraProjects?: ExtraProjectRef[];
  sandbox?: boolean;
  autoReview?: boolean;
  usage?: JobTokenUsage;
  activeTurnId?: string;
  turns: JobTurnSummary[];
};

const jobs = new Map<string, JobRecord>();
let loaded = false;
let writeChain = Promise.resolve();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDirtySince = 0;
const MAX_LOG_ENTRIES = 2000;
const MAX_LOG_MESSAGE_LENGTH = 20000;
const PERSIST_DEBOUNCE_MS = 400;
const PERSIST_MAX_DELAY_MS = 1500;

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
  delivery?: FollowUpDelivery;
  images?: JobImageMeta[];
  loadLocalSettings?: boolean;
  sandbox?: boolean;
  autoReview?: boolean;
  disallowedTools?: ToolName[];
}): JobTurn {
  return {
    id: crypto.randomUUID(),
    prompt: input.prompt,
    status: input.status ?? "queued",
    createdAt: now(),
    mode: input.mode,
    model: input.model,
    delivery: input.delivery,
    images: input.images,
    loadLocalSettings: input.loadLocalSettings,
    sandbox: input.sandbox,
    autoReview: input.autoReview,
    disallowedTools: input.disallowedTools,
  };
}

function insertFollowUpTurn(job: JobRecord, turn: JobTurn, delivery: FollowUpDelivery): void {
  if (delivery !== "interrupt") {
    job.turns.push(turn);
    return;
  }

  const runningIndex = job.turns.findIndex((item) => item.status === "running");
  if (runningIndex >= 0) {
    job.turns.splice(runningIndex + 1, 0, turn);
    return;
  }

  const queuedIndex = job.turns.findIndex((item) => item.status === "queued");
  if (queuedIndex >= 0) {
    job.turns.splice(queuedIndex, 0, turn);
    return;
  }

  job.turns.push(turn);
}

function describeRunSettings(mode: AgentMode, model?: AgentModelSelection): string {
  const modeText = mode === "plan" ? "Plan" : "Agent";
  const modelText = formatModelSelection(model);
  return modelText ? `${modeText} 模式，${modelText}` : `${modeText} 模式`;
}

async function persist(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const records = [...jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await fs.writeFile(jobsFile(), JSON.stringify(records), "utf8");
}

function enqueuePersist(): void {
  writeChain = writeChain.then(persist).catch((error) => {
    console.error("保存任务状态失败", error);
  });
}

function clearPersistTimer(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

function schedulePersist(immediate = false): void {
  if (immediate) {
    persistDirtySince = 0;
    clearPersistTimer();
    enqueuePersist();
    return;
  }

  const nowMs = Date.now();
  if (!persistDirtySince) persistDirtySince = nowMs;
  const waited = nowMs - persistDirtySince;
  const delay = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, PERSIST_MAX_DELAY_MS - waited));
  clearPersistTimer();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistDirtySince = 0;
    enqueuePersist();
  }, delay);
}

export async function flushJobs(): Promise<void> {
  persistDirtySince = 0;
  clearPersistTimer();
  enqueuePersist();
  await writeChain;
}

function toJobSummary(job: JobRecord): JobSummary {
  return {
    id: job.id,
    project: job.project,
    promptSummary: job.promptSummary,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    mode: job.mode,
    model: job.model,
    extraProjects: job.extraProjects,
    sandbox: job.sandbox,
    autoReview: job.autoReview,
    usage: job.usage,
    activeTurnId: job.activeTurnId,
    turns: (job.turns ?? []).map((turn) => ({
      id: turn.id,
      status: turn.status,
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      mode: turn.mode,
    })),
  };
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
    schedulePersist(true);
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
    schedulePersist(true);
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
  extraProjects?: ExtraProjectRef[];
  loadLocalSettings?: boolean;
  sandbox?: boolean;
  autoReview?: boolean;
  disallowedTools?: ToolName[];
  images?: JobImageMeta[];
}): JobRecord {
  const timestamp = now();
  const turn = createTurn({
    prompt: input.prompt,
    mode: input.mode,
    model: input.model,
    images: input.images,
    loadLocalSettings: input.loadLocalSettings,
    sandbox: input.sandbox,
    autoReview: input.autoReview,
    disallowedTools: input.disallowedTools,
  });
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
    extraProjects: input.extraProjects,
    loadLocalSettings: input.loadLocalSettings,
    sandbox: input.sandbox,
    autoReview: input.autoReview,
    disallowedTools: input.disallowedTools,
    turns: [turn],
    activeTurnId: turn.id,
    logs: [],
  };

  jobs.set(job.id, job);
  appendJobLog(job.id, "info", `任务已创建（${describeRunSettings(input.mode, input.model)}），等待执行。`, turn.id);
  schedulePersist(true);
  return job;
}

export function enqueueJobTurn(
  jobId: string,
  input: {
    prompt: string;
    mode: AgentMode;
    model?: AgentModelSelection;
    delivery?: FollowUpDelivery;
    images?: JobImageMeta[];
    loadLocalSettings?: boolean;
    sandbox?: boolean;
    autoReview?: boolean;
    disallowedTools?: ToolName[];
  },
): { job: JobRecord; turn: JobTurn } {
  const rootId = getConversationRootId(jobId);
  const job = jobs.get(rootId);
  if (!job) throw new Error("任务不存在");

  ensureJobTurns(job);
  const delivery = input.delivery ?? "queue";
  const turn = createTurn({
    prompt: input.prompt,
    mode: input.mode,
    model: input.model,
    delivery,
    images: input.images,
    loadLocalSettings: input.loadLocalSettings,
    sandbox: input.sandbox,
    autoReview: input.autoReview,
    disallowedTools: input.disallowedTools,
  });
  insertFollowUpTurn(job, turn, delivery);
  job.mode = input.mode;
  if (input.model) job.model = input.model;
  if (input.loadLocalSettings !== undefined) job.loadLocalSettings = input.loadLocalSettings;
  if (input.sandbox !== undefined) job.sandbox = input.sandbox;
  if (input.autoReview !== undefined) job.autoReview = input.autoReview;
  if (input.disallowedTools) job.disallowedTools = input.disallowedTools;
  job.updatedAt = now();
  syncJobStatusFromTurns(job);

  const busy = job.turns.some((item) => item.id !== turn.id && (item.status === "running" || item.status === "queued"));
  const settings = describeRunSettings(input.mode, input.model);
  let message = `已追加后续指令（${settings}），等待执行。`;
  if (delivery === "interrupt" && busy) {
    message = `已插入追加指令（${settings}），将中断当前轮次并立即执行。`;
  } else if (busy) {
    message = `已加入排队（${settings}），当前轮次结束后将自动执行。`;
  }
  appendJobLog(job.id, "info", message, turn.id);
  schedulePersist(true);
  return { job, turn };
}

export function listJobs(): JobSummary[] {
  return [...jobs.values()]
    .filter((job) => !job.parentJobId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toJobSummary);
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id) ?? jobs.get(getConversationRootId(id));
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord {
  const job = jobs.get(getConversationRootId(id));
  if (!job) throw new Error("任务不存在");

  Object.assign(job, patch, { updatedAt: now() });
  jobs.set(job.id, job);
  schedulePersist(true);
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
  schedulePersist(true);
  return turn;
}

export function appendJobLog(
  id: string,
  level: JobLog["level"],
  message: string,
  turnId?: string,
  source?: string,
): void {
  const job = jobs.get(getConversationRootId(id));
  if (!job) throw new Error("任务不存在");

  const safeMessage =
    message.length > MAX_LOG_MESSAGE_LENGTH ? `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}\n...日志过长，已截断。` : message;
  const resolvedTurnId = turnId || job.activeTurnId;

  const lastLog = job.logs.at(-1);
  // 流式片段按同类日志合并，便于聊天气泡连续展示
  const sameTurnLast = lastLog && lastLog.turnId === resolvedTurnId ? lastLog : undefined;
  if (
    sameTurnLast &&
    (level === "assistant" || level === "thinking") &&
    sameTurnLast.level === level
  ) {
    const mergedMessage = `${sameTurnLast.message}${safeMessage}`;
    sameTurnLast.message =
      mergedMessage.length > MAX_LOG_MESSAGE_LENGTH
        ? `${mergedMessage.slice(0, MAX_LOG_MESSAGE_LENGTH)}\n...日志过长，已截断。`
        : mergedMessage;
    sameTurnLast.time = now();
  } else if (source) {
    let existing;
    for (let index = job.logs.length - 1; index >= 0; index -= 1) {
      const item = job.logs[index];
      if (item.source === source && item.turnId === resolvedTurnId) {
        existing = item;
        break;
      }
    }
    if (existing) {
      existing.message = safeMessage;
      existing.level = level;
      existing.time = now();
    } else {
      job.logs.push({ time: now(), level, message: safeMessage, turnId: resolvedTurnId, source });
    }
  } else {
    job.logs.push({ time: now(), level, message: safeMessage, turnId: resolvedTurnId, source });
  }

  if (job.logs.length > MAX_LOG_ENTRIES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_ENTRIES);
  }
  job.updatedAt = now();
  schedulePersist();
}
