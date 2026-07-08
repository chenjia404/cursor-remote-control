import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import type { ProjectInfo } from "./projects.js";

export type JobStatus = "queued" | "running" | "finished" | "error" | "cancelled";

export type JobLog = {
  time: string;
  level: "info" | "thinking" | "assistant" | "error";
  message: string;
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
  parentJobId?: string;
  result?: string;
  error?: string;
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

async function persist(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const records = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await fs.writeFile(jobsFile(), JSON.stringify(records, null, 2), "utf8");
}

function schedulePersist(): void {
  writeChain = writeChain.then(persist).catch((error) => {
    console.error("保存任务状态失败", error);
  });
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
}

/**
 * 进程内存里的 activeRuns 会在重启后丢失，但 jobs.json 里的 queued/running 会原样保留。
 * 启动时把这类孤儿任务标为 error，避免前端一直显示「AI 正在回复」。
 */
export function recoverInterruptedJobs(): number {
  let count = 0;

  for (const job of [...jobs.values()]) {
    if (!["queued", "running"].includes(job.status)) continue;

    updateJob(job.id, {
      status: "error",
      finishedAt: now(),
      error: "服务进程已重启，任务被中断。",
    });
    appendJobLog(job.id, "error", "服务进程已重启，进行中的任务无法继续，已标记为中断。");
    count += 1;
  }

  return count;
}

export function createJob(input: {
  project: ProjectInfo;
  prompt: string;
  submittedBy: string;
  sourceIp: string;
  parentJobId?: string;
}): JobRecord {
  const timestamp = now();
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
    parentJobId: input.parentJobId,
    logs: [],
  };

  jobs.set(job.id, job);
  appendJobLog(job.id, "info", "任务已创建，等待执行。");
  return job;
}

export function listJobs(): JobRecord[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord {
  const job = jobs.get(id);
  if (!job) throw new Error("任务不存在");

  Object.assign(job, patch, { updatedAt: now() });
  jobs.set(id, job);
  schedulePersist();
  return job;
}

export function appendJobLog(id: string, level: JobLog["level"], message: string): void {
  const job = jobs.get(id);
  if (!job) throw new Error("任务不存在");

  const safeMessage =
    message.length > MAX_LOG_MESSAGE_LENGTH ? `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}\n...日志过长，已截断。` : message;

  const lastLog = job.logs.at(-1);
  // 流式片段按同类日志合并，便于聊天气泡连续展示
  if ((level === "assistant" || level === "thinking") && lastLog?.level === level) {
    const mergedMessage = `${lastLog.message}${safeMessage}`;
    lastLog.message =
      mergedMessage.length > MAX_LOG_MESSAGE_LENGTH
        ? `${mergedMessage.slice(0, MAX_LOG_MESSAGE_LENGTH)}\n...日志过长，已截断。`
        : mergedMessage;
    lastLog.time = now();
  } else {
    job.logs.push({ time: now(), level, message: safeMessage });
  }

  if (job.logs.length > MAX_LOG_ENTRIES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_ENTRIES);
  }
  job.updatedAt = now();
  schedulePersist();
}
