import {
  Agent,
  CursorAgentError,
  UnsupportedRunOperationError,
  type AgentModeOption,
  type AgentOptions,
  type AgentUsage,
  type ModelSelection,
  type Run,
  type SDKUserMessage,
  type SendOptions,
  type TokenUsage,
} from "@cursor/sdk";
import {
  mergeDisallowedTools,
  resolveAgentWorkspace,
  settingSourcesForRun,
  type AgentRunOptions,
} from "./agentOptions.js";
import { config } from "./config.js";
import {
  appendJobLog,
  cancelQueuedTurns,
  getJob,
  getTurn,
  listQueuedJobIds,
  nextQueuedTurn,
  updateJob,
  updateTurn,
  type JobRecord,
  type JobTokenUsage,
  type JobTurn,
} from "./jobs.js";
import { loadJobImagesForSdk } from "./jobImages.js";
import { formatModelSelection, resolveModelSelection, toSdkModel } from "./models.js";

type DisposableAgent = {
  agentId?: string;
  model?: ModelSelection;
  send: (message: string | SDKUserMessage, options?: SendOptions) => Promise<Run>;
  getUsage?: (options?: { runId?: string }) => Promise<AgentUsage>;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

const activeRuns = new Map<string, Run>();
const conversationPumps = new Map<string, Promise<void>>();

function requireCursorApiKey(): string {
  if (!config.cursorApiKey) throw new Error("CURSOR_API_KEY 未配置");
  return config.cursorApiKey;
}

function unwrapSdkMessage(event: unknown): unknown {
  const value = event as { type?: string; message?: unknown };
  // 部分本地运行时会再包一层 sdk_message
  if (value?.type === "sdk_message" && value.message) {
    return value.message;
  }
  return event;
}

function truncatePreview(value: unknown, max = 800): string {
  if (value == null) return "";
  try {
    if (typeof value === "string") {
      return value.length > max ? `${value.slice(0, max)}…` : value;
    }
    const text = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "string" && nested.length > max) return `${nested.slice(0, max)}…`;
      return nested;
    });
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return "[无法显示]";
  }
}

function extractStreamLogs(event: unknown): Array<{
  level: "assistant" | "thinking" | "tool" | "status" | "error";
  text: string;
  source?: string;
}> {
  const value = unwrapSdkMessage(event) as {
    type?: string;
    text?: string;
    name?: string;
    call_id?: string;
    status?: string;
    args?: unknown;
    result?: unknown;
    usage?: TokenUsage;
    tools?: string[];
    message?: string | {
      content?: Array<{ type?: string; text?: string; name?: string }>;
    };
  };

  if (value.type === "assistant") {
    const blocks = typeof value.message === "object" && value.message ? value.message.content ?? [] : [];
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (text) return [{ level: "assistant", text }];
    return [];
  }

  if (value.type === "thinking" && typeof value.text === "string" && value.text) {
    return [{ level: "thinking", text: value.text }];
  }

  if (value.type === "tool_call") {
    const name = value.name || "tool";
    const source = `tool:${value.call_id || name}`;
    if (value.status === "error") {
      const detail = truncatePreview(value.result) || "调用失败";
      return [{ level: "tool", text: `${name} 失败：${detail}`, source }];
    }
    if (value.status === "completed") {
      const detail = truncatePreview(value.result);
      return [{ level: "tool", text: detail ? `${name} 完成\n${detail}` : `${name} 完成`, source }];
    }
    const args = truncatePreview(value.args, 400);
    return [{ level: "tool", text: args ? `调用 ${name}\n${args}` : `调用 ${name}`, source }];
  }

  if (value.type === "task" && typeof value.text === "string" && value.text) {
    return [{ level: "tool", text: value.text, source: `task:${value.status || "update"}` }];
  }

  if (value.type === "status") {
    const status = String(value.status || "").toUpperCase();
    if (status === "ERROR" || status === "CANCELLED" || status === "EXPIRED") {
      const detail = typeof value.message === "string" ? value.message : "";
      return [{ level: "error", text: detail || `Run 状态：${status}` }];
    }
    return [];
  }

  if (value.type === "system" && Array.isArray(value.tools)) {
    const tools = value.tools.filter(Boolean);
    if (tools.length) {
      return [{ level: "status", text: `可用工具：${tools.join("、")}` }];
    }
  }

  return [];
}

function toJobUsage(usage: TokenUsage | undefined): JobTokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    reasoningTokens: usage.reasoningTokens,
  };
}

function formatUsageLabel(usage: JobTokenUsage | undefined): string {
  if (!usage) return "";
  const parts = [`输入 ${usage.inputTokens}`, `输出 ${usage.outputTokens}`, `合计 ${usage.totalTokens}`];
  if (usage.reasoningTokens) parts.push(`思考 ${usage.reasoningTokens}`);
  return parts.join(" · ");
}

async function readTurnUsage(agent: DisposableAgent, fallback?: JobTokenUsage): Promise<JobTokenUsage | undefined> {
  if (!agent.getUsage) return fallback;
  try {
    const billed = await agent.getUsage();
    return toJobUsage(billed.usage) ?? fallback;
  } catch {
    return fallback;
  }
}

function resolveTurnRunOptions(job: JobRecord, turn: JobTurn): AgentRunOptions {
  return {
    loadLocalSettings: turn.loadLocalSettings ?? job.loadLocalSettings ?? true,
    sandbox: turn.sandbox ?? job.sandbox ?? config.cursorSandbox,
    autoReview: turn.autoReview ?? job.autoReview ?? config.cursorAutoReview,
    disallowedTools: turn.disallowedTools ?? job.disallowedTools ?? [],
    extraProjects: job.extraProjects ?? [],
  };
}

function buildAgentCreateOptions(
  job: JobRecord,
  turn: JobTurn,
  model: ModelSelection,
  mode: AgentModeOption,
): AgentOptions {
  const runOptions = resolveTurnRunOptions(job, turn);
  const workspace = resolveAgentWorkspace(job.project.path, runOptions.extraProjects);
  const disallowedTools = mergeDisallowedTools(runOptions.disallowedTools);

  return {
    apiKey: requireCursorApiKey(),
    model,
    mode,
    name: job.project.name,
    ...(disallowedTools ? { disallowedTools } : {}),
    local: {
      cwd: workspace.cwd,
      ...(workspace.dirs.length ? { dirs: workspace.dirs } : {}),
      settingSources: settingSourcesForRun(runOptions.loadLocalSettings),
      ...(runOptions.sandbox ? { sandboxOptions: { enabled: true } } : {}),
      ...(runOptions.autoReview ? { autoReview: true } : {}),
    },
  };
}

function hasAssistantLogs(job: JobRecord, turnId: string): boolean {
  return job.logs.some((log) => log.level === "assistant" && log.turnId === turnId);
}

function resolveTurnMode(job: JobRecord, turn: JobTurn): AgentModeOption {
  return turn.mode ?? job.mode ?? config.cursorDefaultMode;
}

function runSettingsLabel(mode: AgentModeOption, modelLabel: string): string {
  const modeText = mode === "plan" ? "Plan" : "Agent";
  return modelLabel ? `${modeText} 模式，${modelLabel}` : `${modeText} 模式`;
}

async function createAgentForJob(job: JobRecord, turn: JobTurn): Promise<DisposableAgent> {
  const selection = await resolveModelSelection(turn.model ?? job.model);
  const model = toSdkModel(selection);
  const mode = resolveTurnMode(job, turn);
  const modelLabel = formatModelSelection(selection);
  const options = buildAgentCreateOptions(job, turn, model, mode);
  const cwd = options.local?.cwd;
  if (!cwd) throw new Error("任务工作目录无效");

  if (job.agentId) {
    appendJobLog(
      job.id,
      "info",
      `继续已有 Agent：${job.agentId}（${runSettingsLabel(mode, modelLabel)}；工作目录 ${cwd}）`,
      turn.id,
    );
    return (await Agent.resume(job.agentId, options)) as DisposableAgent;
  }

  appendJobLog(job.id, "info", `正在初始化 Agent，工作目录：${cwd}`, turn.id);
  return (await Agent.create(options)) as DisposableAgent;
}

async function disposeAgent(agent: DisposableAgent): Promise<void> {
  const dispose = agent[Symbol.asyncDispose];
  if (dispose) {
    await dispose.call(agent);
  }
}

function isTurnCancelled(jobId: string, turnId: string): boolean {
  const job = getJob(jobId);
  if (!job) return true;
  const turn = getTurn(job, turnId);
  return !turn || turn.status === "cancelled";
}

function markTurnCancelled(jobId: string, turnId: string, message: string): JobRecord {
  updateTurn(jobId, turnId, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    error: undefined,
  });
  appendJobLog(jobId, "info", message, turnId);
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  return job;
}

export async function cancelCursorJob(jobId: string): Promise<JobRecord> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");

  const runningTurn = job.turns.find((turn) => turn.status === "running");
  const queuedTurns = job.turns.filter((turn) => turn.status === "queued");

  if (!runningTurn && queuedTurns.length === 0) {
    return job;
  }

  if (!runningTurn) {
    cancelQueuedTurns(job.id);
    appendJobLog(job.id, "info", "排队中的指令已取消。");
    return getJob(job.id) ?? job;
  }

  const run = activeRuns.get(job.id);
  if (!run) {
    const cancelled = markTurnCancelled(job.id, runningTurn.id, "任务已标记为停止。");
    cancelQueuedTurns(job.id);
    return getJob(cancelled.id) ?? cancelled;
  }

  if (!run.supports("cancel")) {
    const reason = run.unsupportedReason("cancel") || "当前 Cursor SDK 运行不支持取消。";
    appendJobLog(jobId, "error", `停止任务失败：${reason}`, runningTurn.id);
    throw new UnsupportedRunOperationError("cancel", reason);
  }

  appendJobLog(jobId, "info", "正在停止任务。", runningTurn.id);
  await run.cancel();
  const cancelled = markTurnCancelled(job.id, runningTurn.id, "当前轮次已停止。");
  cancelQueuedTurns(job.id);
  return getJob(cancelled.id) ?? cancelled;
}

/** 只中断当前执行轮次，保留排队中的后续指令。 */
export async function interruptRunningTurn(jobId: string): Promise<JobRecord> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");

  const runningTurn = job.turns.find((turn) => turn.status === "running");
  if (!runningTurn) return job;

  const run = activeRuns.get(job.id);
  if (!run) {
    return markTurnCancelled(job.id, runningTurn.id, "当前轮次已中断，改为执行追加指令。");
  }

  if (!run.supports("cancel")) {
    const reason = run.unsupportedReason("cancel") || "当前 Cursor SDK 运行不支持取消。";
    appendJobLog(jobId, "error", `中断当前轮次失败：${reason}`, runningTurn.id);
    throw new UnsupportedRunOperationError("cancel", reason);
  }

  appendJobLog(jobId, "info", "收到追加指令，正在中断当前轮次。", runningTurn.id);
  await run.cancel();
  return getJob(job.id) ?? job;
}

async function pumpConversation(jobId: string): Promise<void> {
  while (true) {
    const next = nextQueuedTurn(jobId);
    if (!next) return;
    await runJobTurn(jobId, next.id);
  }
}

/** 同一任务内串行执行：进行中时后来的指令只入队，结束后自动跑下一轮。 */
export function scheduleConversation(jobId: string): void {
  const job = getJob(jobId);
  if (!job) return;

  const previous = conversationPumps.get(job.id) ?? Promise.resolve();
  const next = previous
    .then(() => pumpConversation(job.id))
    .catch((error) => {
      console.error("会话任务调度失败", error);
    });
  conversationPumps.set(job.id, next);
}

export function resumeQueuedConversations(): number {
  const started = new Set<string>();

  for (const jobId of listQueuedJobIds()) {
    if (started.has(jobId)) continue;
    started.add(jobId);
    scheduleConversation(jobId);
  }

  return started.size;
}

export async function runJobTurn(jobId: string, turnId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");

  const turn = getTurn(job, turnId);
  if (!turn || turn.status !== "queued") return;

  let agent: DisposableAgent | undefined;

  try {
    if (isTurnCancelled(job.id, turn.id)) return;

    updateTurn(job.id, turn.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    updateJob(job.id, { activeTurnId: turn.id });
    const mode = resolveTurnMode(job, turn);
    const selection = await resolveModelSelection(turn.model ?? job.model);
    const modelLabel = formatModelSelection(selection);
    const runOptions = resolveTurnRunOptions(job, turn);
    const extraLabels = [
      runOptions.extraProjects.length ? `附加 ${runOptions.extraProjects.length} 个工作区` : "",
      runOptions.sandbox ? "沙箱" : "",
      runOptions.autoReview ? "Auto-review" : "",
      runOptions.loadLocalSettings ? "已加载本机规则/MCP" : "未加载本机规则",
      runOptions.disallowedTools.length ? `禁用 ${runOptions.disallowedTools.join(", ")}` : "",
    ].filter(Boolean);
    const optionSuffix = extraLabels.length ? `；${extraLabels.join("，")}` : "";
    appendJobLog(
      job.id,
      "info",
      `开始在项目 ${job.project.name} 中执行（${runSettingsLabel(mode, modelLabel)}${optionSuffix}）。`,
      turn.id,
    );

    agent = await createAgentForJob(job, turn);
    updateJob(job.id, { agentId: agent.agentId, activeTurnId: turn.id, model: selection });
    if (isTurnCancelled(job.id, turn.id)) return;

    const images = await loadJobImagesForSdk(job.id, turn.images);
    const prompt = turn.prompt.trim() || (images.length ? "请查看附图。" : "");
    const message: string | SDKUserMessage = images.length ? { text: prompt, images } : prompt;
    const run = await agent.send(message, {
      mode,
      model: toSdkModel(selection),
      ...(turn.delivery === "interrupt" ? { local: { force: true } } : {}),
    });
    activeRuns.set(job.id, run);
    updateJob(job.id, { runId: run.id });
    appendJobLog(job.id, "info", `Run 已启动：${run.id ?? "unknown"}`, turn.id);

    let streamedUsage: JobTokenUsage | undefined;
    if (run.stream) {
      for await (const event of run.stream()) {
        if (isTurnCancelled(job.id, turn.id)) break;

        const payload = unwrapSdkMessage(event) as { type?: string; usage?: TokenUsage };
        if (payload.type === "usage" && payload.usage) {
          streamedUsage = toJobUsage(payload.usage) ?? streamedUsage;
          continue;
        }

        for (const chunk of extractStreamLogs(event)) {
          appendJobLog(job.id, chunk.level, chunk.text, turn.id, chunk.source);
        }
      }
    }

    const result = await run.wait();
    if (result.status === "cancelled" || isTurnCancelled(job.id, turn.id)) {
      markTurnCancelled(job.id, turn.id, "当前轮次已停止。");
      return;
    }

    if (result.status && result.status !== "finished") {
      updateTurn(job.id, turn.id, {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: `Cursor Agent 返回状态：${result.status}`,
      });
      appendJobLog(job.id, "error", `任务失败：${result.status}`, turn.id);
      return;
    }

    if (typeof result.result === "string" && result.result.trim()) {
      const latest = getJob(job.id);
      if (latest && !hasAssistantLogs(latest, turn.id)) {
        appendJobLog(job.id, "assistant", result.result, turn.id);
      }
    }

    const usage = await readTurnUsage(agent, toJobUsage(result.usage) ?? streamedUsage);
    updateTurn(job.id, turn.id, {
      status: "finished",
      finishedAt: new Date().toISOString(),
      result: typeof result.result === "string" ? result.result : undefined,
      usage,
    });
    if (usage) updateJob(job.id, { usage });
    const usageLabel = formatUsageLabel(usage);
    appendJobLog(job.id, "info", usageLabel ? `本轮指令已完成（${usageLabel}）。` : "本轮指令已完成。", turn.id);
  } catch (error) {
    if (isTurnCancelled(job.id, turn.id)) {
      appendJobLog(job.id, "info", "当前轮次已停止。", turn.id);
      return;
    }

    const message =
      error instanceof CursorAgentError
        ? `Cursor Agent 启动失败：${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);

    updateTurn(job.id, turn.id, {
      status: "error",
      finishedAt: new Date().toISOString(),
      error: message,
    });
    appendJobLog(job.id, "error", message, turn.id);
  } finally {
    activeRuns.delete(job.id);
    if (agent) {
      await disposeAgent(agent).catch((error) => {
        appendJobLog(
          job.id,
          "error",
          `释放 Agent 资源失败：${error instanceof Error ? error.message : String(error)}`,
          turn.id,
        );
      });
    }
  }
}
