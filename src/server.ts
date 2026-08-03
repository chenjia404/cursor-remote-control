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
import { cancelCursorJob, runCursorJob } from "./cursorAgent.js";
import { createJob, getJob, listJobs, loadJobs, recoverInterruptedJobs } from "./jobs.js";
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

const createJobSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(20000),
  parentJobId: z.string().uuid().optional(),
  mode: z.enum(["agent", "plan"]).optional(),
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

  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: 128 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
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
    },
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

    const csrfToken = await issueSession(reply, body.username);
    return { username: body.username, csrfToken };
  });

  app.post("/api/logout", { preHandler: requireCsrf }, async (request, reply) => {
    await clearSession(reply, request.sessionId);
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
    const body = createJobSchema.parse(request.body);
    const project = await getProjectById(body.projectId);

    // 新建会话必须使用已确认项目；续聊可沿用历史任务中的项目路径
    if (!body.parentJobId && !(await isProjectSelected(body.projectId))) {
      reply.code(400).send({ error: "请先在「按目录打开」中确认该项目" });
      return;
    }

    const job = createJob({
      project,
      prompt: body.prompt,
      submittedBy: request.user?.username ?? config.adminUsername,
      sourceIp: getRequestIp(request.ip),
      parentJobId: body.parentJobId,
      mode: body.mode ?? config.cursorDefaultMode,
    });

    runCursorJob(job.id).catch((error) => {
      request.log.error({ error, jobId: job.id }, "任务后台执行失败");
    });

    reply.code(202).send({ job });
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

    app.log.error(error);
    reply.code(500).send({ error: "服务器内部错误" });
  });

  await app.listen({ host: config.host, port: config.port });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
