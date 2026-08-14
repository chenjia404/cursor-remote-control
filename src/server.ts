import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  clearSession,
  issueSession,
  loadActiveSession,
  requireAuth,
  requireCsrf,
  verifyPassword,
} from "./auth.js";
import { assertRequiredConfig, config } from "./config.js";
import {
  cancelCursorJob,
  interruptRunningTurn,
  resumeQueuedConversations,
  scheduleConversation,
} from "./cursorAgent.js";
import { createJob, enqueueJobTurn, getJob, listJobs, loadJobs, recoverInterruptedJobs } from "./jobs.js";
import { defaultModelSelection, listCursorModels, normalizeModelSelection, warmupModelCatalog } from "./models.js";
import {
  browseDirectory,
  getProjectById,
  isProjectSelected,
  listSelectedProjects,
  loadSelectedProjects,
  selectProject,
  unselectProject,
} from "./projects.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const modelSelectionSchema = z.object({
  id: z.string().min(1).max(80),
  params: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        value: z.string().min(1).max(64),
      }),
    )
    .max(16)
    .optional(),
});

const createJobSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(20000),
  parentJobId: z.string().uuid().optional(),
  mode: z.enum(["agent", "plan"]).optional(),
  model: modelSelectionSchema.optional(),
});

const followUpSchema = z.object({
  prompt: z.string().min(1).max(20000),
  mode: z.enum(["agent", "plan"]).optional(),
  model: modelSelectionSchema.optional(),
  delivery: z.enum(["queue", "interrupt"]).optional(),
});

const browseSchema = z.object({
  path: z.string().optional(),
});

const selectProjectSchema = z.object({
  path: z.string().min(1),
});

function getRequestIp(requestIp: string | undefined): string {
  return requestIp || "unknown";
}

async function start(): Promise<void> {
  assertRequiredConfig();
  await Promise.all([loadJobs(), loadSelectedProjects(), loadActiveSession()]);
  const recoveredCount = recoverInterruptedJobs();
  if (recoveredCount > 0) {
    console.warn(`已将 ${recoveredCount} 个因进程重启而中断的任务标记为失败`);
  }
  const resumedConversations = resumeQueuedConversations();
  if (resumedConversations > 0) {
    console.info(`已恢复 ${resumedConversations} 个会话中排队等待的任务`);
  }
  warmupModelCatalog();

  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: 128 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    // 避免与 Cloudflare 的 ACAO:* 叠加后干扰模块脚本加载
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
  await app.register(fastifyStatic, {
    root: path.join(config.appRoot, "src", "public"),
    prefix: "/",
    setHeaders(reply, filePath) {
      if (filePath.endsWith(".webmanifest")) {
        reply.header("Content-Type", "application/manifest+json; charset=utf-8");
      }
      // 入口、脚本和样式不要被 CDN / 反代按扩展名缓存。
      // 部分 CDN 默认缓存 .css，一旦缓存了 404，页面会一直丢样式。
      const fileName = path.basename(filePath);
      if (
        fileName === "index.html" ||
        fileName === "boot.js" ||
        fileName === "app.js" ||
        fileName === "i18n.js" ||
        fileName === "sw.js" ||
        fileName === "version.js" ||
        fileName === "styles.css"
      ) {
        reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  });

  // 登录表单若被浏览器原生提交，不要返回 JSON 404 页
  app.post("/", async (_request, reply) => {
    reply.redirect("/");
  });

  app.get("/health", async () => ({
    ok: true,
    version: config.appVersion,
  }));

  app.post("/api/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    if (body.username !== config.adminUsername || !config.adminPasswordHash) {
      reply.code(401).send({ error: "用户名或密码错误" });
      return;
    }

    if (!verifyPassword(body.password, config.adminPasswordHash)) {
      reply.code(401).send({ error: "用户名或密码错误" });
      return;
    }

    const issued = await issueSession(reply, body.username, request);
    return {
      username: body.username,
      csrfToken: issued.csrfToken,
      sessionToken: issued.sessionToken,
    };
  });

  app.post("/api/logout", { preHandler: requireCsrf }, async (request, reply) => {
    await clearSession(reply, request.sessionId, request);
    return { ok: true };
  });

  app.get("/api/session", { preHandler: requireAuth }, async (request) => ({
    username: request.user?.username,
    csrfToken: request.csrfToken,
    version: config.appVersion,
  }));

  app.get("/api/projects", { preHandler: requireAuth }, async () => ({
    projects: await listSelectedProjects(),
  }));

  app.get("/api/models", { preHandler: requireAuth }, async () => {
    const models = await listCursorModels();
    return {
      models,
      defaultModel: defaultModelSelection(models),
    };
  });

  app.get("/api/projects/browse", { preHandler: requireAuth }, async (request, reply) => {
    const query = browseSchema.parse(request.query);
    try {
      return await browseDirectory(query.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
    }
  });

  app.post("/api/projects/select", { preHandler: requireCsrf }, async (request, reply) => {
    const body = selectProjectSchema.parse(request.body);
    try {
      const project = await selectProject(body.path);
      return { project };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
    }
  });

  app.delete("/api/projects/:id", { preHandler: requireCsrf }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      await unselectProject(params.id);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
    }
  });

  app.get("/api/jobs", { preHandler: requireAuth }, async () => ({
    jobs: listJobs(),
  }));

  app.get("/api/jobs/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = getJob(params.id);
    if (!job) {
      reply.code(404).send({ error: "任务不存在" });
      return;
    }

    return { job };
  });

  app.post("/api/jobs", { preHandler: requireCsrf }, async (request, reply) => {
    const catalog = await listCursorModels();
    const body = createJobSchema.parse(request.body);
    const model = normalizeModelSelection(body.model, catalog);

    // 提交区选择「继续已有任务」时，在同一任务内追加一轮，不新建任务
    if (body.parentJobId) {
      const parent = getJob(body.parentJobId);
      if (!parent) {
        reply.code(404).send({ error: "任务不存在" });
        return;
      }

      const job = enqueueJobTurn(parent.id, {
        prompt: body.prompt,
        mode: body.mode ?? parent.mode ?? config.cursorDefaultMode,
        model,
      });
      scheduleConversation(job.id);
      reply.code(202).send({ job });
      return;
    }

    const project = await getProjectById(body.projectId);
    if (!(await isProjectSelected(body.projectId))) {
      reply.code(400).send({ error: "请先在「按目录打开」中确认该项目" });
      return;
    }

    const job = createJob({
      project,
      prompt: body.prompt,
      submittedBy: request.user?.username ?? config.adminUsername,
      sourceIp: getRequestIp(request.ip),
      mode: body.mode ?? config.cursorDefaultMode,
      model,
    });

    scheduleConversation(job.id);
    reply.code(202).send({ job });
  });

  app.post("/api/jobs/:id/messages", { preHandler: requireCsrf }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const catalog = await listCursorModels();
    const body = followUpSchema.parse(request.body);
    const existing = getJob(params.id);
    if (!existing) {
      reply.code(404).send({ error: "任务不存在" });
      return;
    }

    const delivery = body.delivery ?? "queue";
    const wasRunning = existing.turns.some((turn) => turn.status === "running");
    const job = enqueueJobTurn(existing.id, {
      prompt: body.prompt,
      mode: body.mode ?? existing.mode ?? config.cursorDefaultMode,
      model: normalizeModelSelection(body.model ?? existing.model, catalog),
      delivery,
    });

    if (delivery === "interrupt" && wasRunning) {
      try {
        await interruptRunningTurn(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.code(409).send({ error: message, job: getJob(job.id) ?? job });
        return;
      }
    }

    scheduleConversation(job.id);
    reply.code(202).send({ job: getJob(job.id) ?? job });
  });

  app.post("/api/jobs/:id/cancel", { preHandler: requireCsrf }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = getJob(params.id);
    if (!job) {
      reply.code(404).send({ error: "任务不存在" });
      return;
    }

    try {
      const updatedJob = await cancelCursorJob(params.id);
      return { job: updatedJob };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(409).send({ error: message });
      return;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({ error: "请求参数错误", details: error.issues });
      return;
    }

    const fastifyError = error as { statusCode?: number; code?: string };
    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      reply.code(fastifyError.statusCode).send({ error: "请求参数错误" });
      return;
    }

    app.log.error(error);
    reply.code(500).send({ error: "服务器内部错误" });
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      listen: `http://${config.host}:${config.port}`,
      publicBaseUrl: config.publicBaseUrl || "",
      cookieSecure: config.cookieSecure,
      trustProxy: true,
    },
    "started (HTTP behind optional HTTPS reverse proxy; forward X-Forwarded-Proto)",
  );
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
