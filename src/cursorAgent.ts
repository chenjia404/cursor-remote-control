import { Agent, CursorAgentError } from "@cursor/sdk";
import { config } from "./config.js";
import { appendJobLog, getJob, updateJob, type JobRecord } from "./jobs.js";

type DisposableAgent = {
  agentId?: string;
  send: (prompt: string) => Promise<{
    id?: string;
    stream?: () => AsyncIterable<unknown>;
    wait: () => Promise<unknown>;
  }>;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

function requireCursorApiKey(): string {
  if (!config.cursorApiKey) throw new Error("CURSOR_API_KEY 未配置");
  return config.cursorApiKey;
}

function extractAssistantText(event: unknown): string {
  const value = event as {
    type?: string;
    message?: {
      content?: Array<{ type?: string; text?: string }>;
    };
  };

  if (value.type !== "assistant") return "";
  const blocks = value.message?.content ?? [];
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function createAgentForJob(job: JobRecord): Promise<DisposableAgent> {
  const apiKey = requireCursorApiKey();
  const parentJob = job.parentJobId ? getJob(job.parentJobId) : undefined;

  if (parentJob?.agentId) {
    appendJobLog(job.id, "info", `继续已有 Agent：${parentJob.agentId}`);
    return (await Agent.resume(parentJob.agentId, { apiKey })) as DisposableAgent;
  }

  return (await Agent.create({
    apiKey,
    model: { id: config.cursorModel },
    local: { cwd: job.project.path },
  })) as DisposableAgent;
}

async function disposeAgent(agent: DisposableAgent): Promise<void> {
  const dispose = agent[Symbol.asyncDispose];
  if (dispose) {
    await dispose.call(agent);
  }
}

export async function runCursorJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");

  let agent: DisposableAgent | undefined;

  try {
    updateJob(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    appendJobLog(job.id, "info", `开始在项目 ${job.project.name} 中执行。`);

    agent = await createAgentForJob(job);
    updateJob(job.id, { agentId: agent.agentId });

    const run = await agent.send(job.prompt);
    updateJob(job.id, { runId: run.id });
    appendJobLog(job.id, "info", `Run 已启动：${run.id ?? "unknown"}`);

    if (run.stream) {
      let assistantBuffer = "";
      const flushAssistantBuffer = () => {
        if (!assistantBuffer) return;
        appendJobLog(job.id, "assistant", assistantBuffer);
        assistantBuffer = "";
      };

      for await (const event of run.stream()) {
        const text = extractAssistantText(event);
        if (!text) continue;

        assistantBuffer += text;
        if (assistantBuffer.length >= 1000 || assistantBuffer.includes("\n\n")) {
          flushAssistantBuffer();
        }
      }

      flushAssistantBuffer();
    }

    const result = (await run.wait()) as { status?: string; result?: string };
    if (result.status && result.status !== "finished") {
      updateJob(job.id, {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: `Cursor Agent 返回状态：${result.status}`,
      });
      appendJobLog(job.id, "error", `任务失败：${result.status}`);
      return;
    }

    updateJob(job.id, {
      status: "finished",
      finishedAt: new Date().toISOString(),
      result: result.result,
    });
    appendJobLog(job.id, "info", "任务已完成。");
  } catch (error) {
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
    if (agent) {
      await disposeAgent(agent).catch((error) => {
        appendJobLog(job.id, "error", `释放 Agent 资源失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
