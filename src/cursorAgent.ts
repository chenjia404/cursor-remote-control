import {
  Agent,
  CursorAgentError,
  UnsupportedRunOperationError,
  type ModelSelection,
  type Run,
  type SendOptions,
} from "@cursor/sdk";
import { config } from "./config.js";
import { appendJobLog, getJob, updateJob, type JobRecord } from "./jobs.js";

type DisposableAgent = {
  agentId?: string;
  model?: ModelSelection;
  send: (prompt: string, options?: SendOptions) => Promise<Run>;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

const activeRuns = new Map<string, Run>();

function requireCursorApiKey(): string {
  if (!config.cursorApiKey) throw new Error("CURSOR_API_KEY 未配置");
  return config.cursorApiKey;
}

function resolveModelSelection(agent?: DisposableAgent): ModelSelection {
  if (agent?.model?.id) return agent.model;
  return { id: config.cursorModel };
}

function unwrapSdkMessage(event: unknown): unknown {
  const value = event as { type?: string; message?: unknown };
  // 部分本地运行时会再包一层 sdk_message
  if (value?.type === "sdk_message" && value.message) {
    return value.message;
  }
  return event;
}

function extractStreamText(
  event: unknown,
): { level: "assistant" | "thinking"; text: string } | null {
  const value = unwrapSdkMessage(event) as {
    type?: string;
    text?: string;
    message?: {
      content?: Array<{ type?: string; text?: string }>;
    };
  };

  if (value.type === "assistant") {
    const blocks = value.message?.content ?? [];
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    return text ? { level: "assistant", text } : null;
  }

  if (value.type === "thinking" && typeof value.text === "string" && value.text) {
    return { level: "thinking", text: value.text };
  }

  return null;
}

function hasAssistantLogs(job: JobRecord): boolean {
  return job.logs.some((log) => log.level === "assistant");
}

async function createAgentForJob(job: JobRecord): Promise<DisposableAgent> {
  const apiKey = requireCursorApiKey();
  const parentJob = job.parentJobId ? getJob(job.parentJobId) : undefined;
  const model = { id: config.cursorModel };

  if (parentJob?.agentId) {
    appendJobLog(job.id, "info", `继续已有 Agent：${parentJob.agentId}`);
    // Local SDK resume 同样需要显式 model，否则会直接失败
    return (await Agent.resume(parentJob.agentId, {
      apiKey,
      model,
      local: { cwd: job.project.path },
    })) as DisposableAgent;
  }

  return (await Agent.create({
    apiKey,
    model,
    local: { cwd: job.project.path },
  })) as DisposableAgent;
}

async function disposeAgent(agent: DisposableAgent): Promise<void> {
  const dispose = agent[Symbol.asyncDispose];
  if (dispose) {
    await dispose.call(agent);
  }
}

function isJobCancelled(jobId: string): boolean {
  return getJob(jobId)?.status === "cancelled";
}

function markJobCancelled(jobId: string, message: string): JobRecord {
  const job = updateJob(jobId, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    error: undefined,
  });
  appendJobLog(jobId, "info", message);
  return job;
}

export async function cancelCursorJob(jobId: string): Promise<JobRecord> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");

  if (!["queued", "running"].includes(job.status)) {
    return job;
  }

  const run = activeRuns.get(jobId);
  if (!run) {
    return markJobCancelled(jobId, "任务已标记为停止。");
  }

  if (!run.supports("cancel")) {
    const reason = run.unsupportedReason("cancel") || "当前 Cursor SDK 运行不支持取消。";
    appendJobLog(jobId, "error", `停止任务失败：${reason}`);
    throw new UnsupportedRunOperationError("cancel", reason);
  }

  appendJobLog(jobId, "info", "正在停止任务。");
  await run.cancel();
  return markJobCancelled(jobId, "任务已停止。");
}

export async function runCursorJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");

  let agent: DisposableAgent | undefined;

  try {
    if (isJobCancelled(job.id)) return;

    updateJob(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    appendJobLog(job.id, "info", `开始在项目 ${job.project.name} 中执行。`);

    agent = await createAgentForJob(job);
    updateJob(job.id, { agentId: agent.agentId });
    if (isJobCancelled(job.id)) return;

    const run = await agent.send(job.prompt);
    activeRuns.set(job.id, run);
    updateJob(job.id, { runId: run.id });
    appendJobLog(job.id, "info", `Run 已启动：${run.id ?? "unknown"}`);

    if (run.stream) {
      // assistant / thinking 分开落库：前端可分别展示思考过程与正式回复
      for await (const event of run.stream()) {
        if (isJobCancelled(job.id)) break;

        const chunk = extractStreamText(event);
        if (!chunk) continue;
        appendJobLog(job.id, chunk.level, chunk.text);
      }
    }

    const result = await run.wait();
    if (result.status === "cancelled" || isJobCancelled(job.id)) {
      markJobCancelled(job.id, "任务已停止。");
      return;
    }

    if (result.status && result.status !== "finished") {
      updateJob(job.id, {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: `Cursor Agent 返回状态：${result.status}`,
      });
      appendJobLog(job.id, "error", `任务失败：${result.status}`);
      return;
    }

    // stream 未产出文本时，用 wait() 的最终 result 兜底写入对话
    if (typeof result.result === "string" && result.result.trim()) {
      const latest = getJob(job.id);
      if (latest && !hasAssistantLogs(latest)) {
        appendJobLog(job.id, "assistant", result.result);
      }
    }

    updateJob(job.id, {
      status: "finished",
      finishedAt: new Date().toISOString(),
      result: result.result,
    });
    appendJobLog(job.id, "info", "任务已完成。");
  } catch (error) {
    if (isJobCancelled(job.id)) {
      appendJobLog(job.id, "info", "任务已停止。");
      return;
    }

    const message =
      error instanceof CursorAgentError
        ? `Cursor Agent 启动失败：${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);

    updateJob(job.id, {
      status: "error",
      finishedAt: new Date().toISOString(),
      error: message,
    });
    appendJobLog(job.id, "error", message);
  } finally {
    activeRuns.delete(job.id);
    if (agent) {
      await disposeAgent(agent).catch((error) => {
        appendJobLog(job.id, "error", `释放 Agent 资源失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
