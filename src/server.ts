import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  publicAgentOptionDefaults,
  resolveExtraProjects,
  resolveRunOptions,
  sanitizeToolNames,
} from "./agentOptions.js";
import { userCanManageSchedule, userCanOperateJob, userCanUseProject, userCanViewJob } from "./access.js";
import {
  clearSession,
  deleteUserSessions,
  getRawSessionToken,
  issueSession,
  loadActiveSession,
  requireAuth,
  requireCsrf,
  requirePermission,
  toAuthenticatedUser,
  type AuthenticatedUser,
} from "./auth.js";
import { assertRequiredConfig, config } from "./config.js";
import { initDatabase } from "./db.js";
import { hasPermission, isRole, publicPermissionCatalog, resolvePermissions, sanitizePermissions } from "./permissions.js";
import {
  assertPasswordStrength,
  generatePasswordHash,
  generateRandomPassword,
  verifyPassword,
} from "./passwords.js";
import {
  addUserProject,
  assertHasActiveAdmin,
  bootstrapAdminFromEnv,
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  toPublicUser,
  updateUser,
} from "./users.js";
import {
  cancelCursorJob,
  interruptRunningTurn,
  resumeQueuedConversations,
  scheduleConversation,
} from "./cursorAgent.js";
import { ScheduleTriggerError, startScheduler, stopScheduler, triggerSchedule } from "./scheduler.js";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
} from "./schedules.js";
import {
  createJob,
  enqueueJobTurn,
  flushJobs,
  getJob,
  listJobs,
  loadJobs,
  recoverInterruptedJobs,
  subscribeJobUpdates,
  updateTurn,
} from "./jobs.js";
import { readJobImage, saveJobImages } from "./jobImages.js";
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

const agentRunOptionsSchema = {
  extraProjectIds: z.array(z.string().min(1)).max(8).optional(),
  loadLocalSettings: z.boolean().optional(),
  sandbox: z.boolean().optional(),
  autoReview: z.boolean().optional(),
  disallowedTools: z.array(z.string().min(1).max(64)).max(32).optional(),
  images: z
    .array(
      z.object({
        mimeType: z.string().min(1).max(64).optional(),
        data: z.string().min(1),
      }),
    )
    .max(4)
    .optional(),
};

const createJobSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().max(20000).default(""),
  parentJobId: z.string().uuid().optional(),
  mode: z.enum(["agent", "plan"]).optional(),
  model: modelSelectionSchema.optional(),
  ...agentRunOptionsSchema,
});

const followUpSchema = z.object({
  prompt: z.string().max(20000).default(""),
  mode: z.enum(["agent", "plan"]).optional(),
  model: modelSelectionSchema.optional(),
  delivery: z.enum(["queue", "interrupt"]).optional(),
  loadLocalSettings: z.boolean().optional(),
  sandbox: z.boolean().optional(),
  autoReview: z.boolean().optional(),
  disallowedTools: z.array(z.string().min(1).max(64)).max(32).optional(),
  images: agentRunOptionsSchema.images,
});

const simpleScheduleSchema = z.object({
  frequency: z.enum(["daily", "weekly", "interval"]),
  time: z.string().max(8).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  intervalHours: z.number().int().min(1).max(168).optional(),
});

const createScheduleSchema = z.object({
  name: z.string().min(1).max(80),
  projectId: z.string().min(1),
  enabled: z.boolean().optional(),
  kind: z.enum(["simple", "cron"]),
  simple: simpleScheduleSchema.optional(),
  cronExpr: z.string().max(80).optional(),
  prompt: z.string().min(1).max(20000),
  resumeLast: z.boolean().optional(),
  mode: z.enum(["agent", "plan"]).optional(),
  model: modelSelectionSchema.optional(),
  extraProjectIds: z.array(z.string().min(1)).max(8).optional(),
  loadLocalSettings: z.boolean().optional(),
  sandbox: z.boolean().optional(),
  autoReview: z.boolean().optional(),
  disallowedTools: z.array(z.string().min(1).max(64)).max(32).optional(),
});

const patchScheduleSchema = createScheduleSchema.partial();

const browseSchema = z.object({
  path: z.string().optional(),
});

const selectProjectSchema = z.object({
  path: z.string().min(1),
});

const createUserSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().optional(),
  role: z.enum(["admin", "operator", "viewer"]),
  grants: z.array(z.string()).optional(),
  denies: z.array(z.string()).optional(),
  allowedProjectIds: z.array(z.string()).optional(),
});

const patchUserSchema = z.object({
  role: z.enum(["admin", "operator", "viewer"]).optional(),
  grants: z.array(z.string()).optional(),
  denies: z.array(z.string()).optional(),
  allowedProjectIds: z.array(z.string()).optional(),
  disabled: z.boolean().optional(),
});

const adminPasswordSchema = z.object({
  password: z.string().optional(),
});

const selfPasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

function getRequestIp(requestIp: string | undefined): string {
  return requestIp || "unknown";
}

function requirePromptOrImages(prompt: string, images: unknown): string {
  const text = prompt.trim();
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!text && !hasImages) {
    throw new Error("请输入任务指令或附加图片");
  }
  return text || "（附图）";
}

function sessionFields(user: AuthenticatedUser) {
  return {
    username: user.username,
    role: user.role,
    permissions: user.permissions,
    allowedProjectIds: user.allowedProjectIds,
  };
}

function sendForbidden(reply: { code: (status: number) => { send: (payload: { error: string }) => unknown } }, message = "没有权限") {
  reply.code(403).send({ error: message });
}

async function resolveWritableProject(user: AuthenticatedUser | undefined, projectId: string) {
  if (!(await isProjectSelected(projectId))) {
    throw new Error("请先在「浏览目录」中确认该项目");
  }
  if (!userCanUseProject(user, projectId)) {
    throw new Error("没有该项目的使用权限");
  }
  return getProjectById(projectId);
}

async function start(): Promise<void> {
  assertRequiredConfig();
  initDatabase();
  bootstrapAdminFromEnv();
  assertHasActiveAdmin();
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
    bodyLimit: 32 * 1024 * 1024,
    requestTimeout: 0,
    connectionTimeout: 0,
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
        imgSrc: ["'self'", "data:", "blob:"],
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
    const user = getUserByUsername(body.username);
    if (!user || user.disabled || !verifyPassword(body.password, user.passwordHash)) {
      reply.code(401).send({ error: "用户名或密码错误" });
      return;
    }

    const issued = await issueSession(reply, user, request);
    const authUser = toAuthenticatedUser(user);
    return {
      ...sessionFields(authUser),
      csrfToken: issued.csrfToken,
      sessionToken: issued.sessionToken,
      agentOptions: publicAgentOptionDefaults(),
    };
  });

  app.post("/api/logout", { preHandler: requireCsrf }, async (request, reply) => {
    await clearSession(reply, request.sessionId, request);
    return { ok: true };
  });

  app.get("/api/session", { preHandler: requireAuth }, async (request) => ({
    ...sessionFields(request.user!),
    csrfToken: request.csrfToken,
    sessionToken: getRawSessionToken(request),
    version: config.appVersion,
    agentOptions: publicAgentOptionDefaults(),
  }));

  app.get("/api/permissions", { preHandler: requireAuth }, async () => publicPermissionCatalog());

  app.get("/api/projects", { preHandler: requireAuth }, async (request) => {
    const projects = await listSelectedProjects();
    return {
      projects: projects.filter((project) => userCanUseProject(request.user, project.id)),
    };
  });

  app.get("/api/models", { preHandler: requireAuth }, async () => {
    const models = await listCursorModels();
    return {
      models,
      defaultModel: defaultModelSelection(models),
    };
  });

  app.get("/api/projects/browse", { preHandler: [requireAuth, requirePermission("projects.browse")] }, async (request, reply) => {
    const query = browseSchema.parse(request.query);
    try {
      return await browseDirectory(query.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
    }
  });

  app.post("/api/projects/select", { preHandler: [requireCsrf, requirePermission("projects.select")] }, async (request, reply) => {
    const body = selectProjectSchema.parse(request.body);
    try {
      const project = await selectProject(body.path);
      if (request.user) addUserProject(request.user.id, project.id);
      return { project };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
    }
  });

  app.delete("/api/projects/:id", { preHandler: [requireCsrf, requirePermission("projects.select")] }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      await unselectProject(params.id);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
    }
  });

  app.get("/api/jobs", { preHandler: requireAuth }, async (request) => ({
    jobs: listJobs(
      hasPermission(request.user?.permissions, "jobs.viewAll") ? undefined : { submittedBy: request.user?.username },
    ),
  }));

  app.get("/api/jobs/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = getJob(params.id);
    if (!job) {
      reply.code(404).send({ error: "任务不存在" });
      return;
    }
    if (!userCanViewJob(request.user, job.submittedBy)) {
      sendForbidden(reply);
      return;
    }

    return { job };
  });

  app.get("/api/jobs/:id/events", {
    preHandler: requireAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = getJob(params.id);
    if (!job) {
      reply.code(404).send({ error: "任务不存在" });
      return;
    }
    if (!userCanViewJob(request.user, job.submittedBy)) {
      sendForbidden(reply);
      return;
    }

    reply.hijack();
    request.raw.setTimeout(0);
    request.socket.setTimeout(0);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let cleaned = false;
    let unsubscribe = (): void => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    const writeEvent = (event: string, payload: unknown) => {
      if (cleaned) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        cleanup();
      }
    };

    heartbeat = setInterval(() => {
      if (cleaned) return;
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, 20000);

    unsubscribe = subscribeJobUpdates(job.id, (event) => {
      writeEvent(event.type, event);
    });

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    reply.raw.on("error", cleanup);
    reply.raw.on("close", cleanup);
  });

  app.post("/api/jobs", { preHandler: requireCsrf }, async (request, reply) => {
    const catalog = await listCursorModels();
    const body = createJobSchema.parse(request.body);
    const model = normalizeModelSelection(body.model, catalog);
    let prompt: string;
    try {
      prompt = requirePromptOrImages(body.prompt, body.images);
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const runOptions = resolveRunOptions({
      loadLocalSettings: body.loadLocalSettings,
      sandbox: body.sandbox,
      autoReview: body.autoReview,
      disallowedTools: sanitizeToolNames(body.disallowedTools),
    });

    // 提交区选择「继续已有任务」时，在同一任务内追加一轮，不新建任务
    if (body.parentJobId) {
      const parent = getJob(body.parentJobId);
      if (!parent) {
        reply.code(404).send({ error: "任务不存在" });
        return;
      }
      if (!userCanOperateJob(request.user, parent.submittedBy, "jobs.followUp")) {
        sendForbidden(reply);
        return;
      }

      let images;
      try {
        images = await saveJobImages(parent.id, body.images);
      } catch (error) {
        reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }

      const { job } = enqueueJobTurn(parent.id, {
        prompt,
        mode: body.mode ?? parent.mode ?? config.cursorDefaultMode,
        model,
        images,
        loadLocalSettings: runOptions.loadLocalSettings,
        sandbox: runOptions.sandbox,
        autoReview: runOptions.autoReview,
        disallowedTools: runOptions.disallowedTools,
      });
      scheduleConversation(job.id);
      reply.code(202).send({ job: getJob(job.id) ?? job });
      return;
    }

    if (!hasPermission(request.user?.permissions, "jobs.create")) {
      sendForbidden(reply);
      return;
    }

    const project = await getProjectById(body.projectId);
    if (!(await isProjectSelected(body.projectId))) {
      reply.code(400).send({ error: "请先在「浏览目录」中确认该项目" });
      return;
    }
    if (!userCanUseProject(request.user, body.projectId)) {
      sendForbidden(reply, "没有该项目的使用权限");
      return;
    }

    let extraProjects;
    try {
      extraProjects = await resolveExtraProjects(body.extraProjectIds, body.projectId);
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (extraProjects.some((item) => !userCanUseProject(request.user, item.id))) {
      sendForbidden(reply, "没有该项目的使用权限");
      return;
    }

    const job = createJob({
      project,
      prompt,
      submittedBy: request.user?.username ?? config.adminUsername,
      sourceIp: getRequestIp(request.ip),
      mode: body.mode ?? config.cursorDefaultMode,
      model,
      extraProjects,
      loadLocalSettings: runOptions.loadLocalSettings,
      sandbox: runOptions.sandbox,
      autoReview: runOptions.autoReview,
      disallowedTools: runOptions.disallowedTools,
    });

    try {
      const firstTurn = job.turns[0];
      if (!firstTurn) throw new Error("任务轮次不存在");
      const images = await saveJobImages(job.id, body.images);
      if (images.length) updateTurn(job.id, firstTurn.id, { images });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const firstTurn = job.turns[0];
      if (firstTurn) {
        updateTurn(job.id, firstTurn.id, {
          status: "error",
          finishedAt: new Date().toISOString(),
          error: message,
        });
      }
      reply.code(400).send({ error: message });
      return;
    }

    scheduleConversation(job.id);
    reply.code(202).send({ job: getJob(job.id) ?? job });
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
    if (!userCanOperateJob(request.user, existing.submittedBy, "jobs.followUp")) {
      sendForbidden(reply);
      return;
    }

    let prompt: string;
    try {
      prompt = requirePromptOrImages(body.prompt, body.images);
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const runOptions = resolveRunOptions({
      loadLocalSettings: body.loadLocalSettings ?? existing.loadLocalSettings,
      sandbox: body.sandbox ?? existing.sandbox,
      autoReview: body.autoReview ?? existing.autoReview,
      disallowedTools: sanitizeToolNames(body.disallowedTools ?? existing.disallowedTools),
    });

    let images;
    try {
      images = await saveJobImages(existing.id, body.images);
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const delivery = body.delivery ?? "queue";
    const wasRunning = existing.turns.some((turn) => turn.status === "running");
    const { job } = enqueueJobTurn(existing.id, {
      prompt,
      mode: body.mode ?? existing.mode ?? config.cursorDefaultMode,
      model: normalizeModelSelection(body.model ?? existing.model, catalog),
      delivery,
      images,
      loadLocalSettings: runOptions.loadLocalSettings,
      sandbox: runOptions.sandbox,
      autoReview: runOptions.autoReview,
      disallowedTools: runOptions.disallowedTools,
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

  app.get("/api/jobs/:id/images/:imageId", { preHandler: requireAuth }, async (request, reply) => {
    const params = z
      .object({
        id: z.string().uuid(),
        imageId: z.string().uuid(),
      })
      .parse(request.params);
    const job = getJob(params.id);
    if (!job) {
      reply.code(404).send({ error: "任务不存在" });
      return;
    }
    if (!userCanViewJob(request.user, job.submittedBy)) {
      sendForbidden(reply);
      return;
    }

    const referenced = (job.turns ?? []).some((turn) => turn.images?.some((item) => item.id === params.imageId));
    if (!referenced) {
      reply.code(404).send({ error: "图片不存在" });
      return;
    }

    const image = await readJobImage(job.id, params.imageId);
    if (!image) {
      reply.code(404).send({ error: "图片不存在" });
      return;
    }

    reply.header("Cache-Control", "private, max-age=86400");
    return reply.type(image.mimeType).send(image.buffer);
  });

  app.post("/api/jobs/:id/cancel", { preHandler: requireCsrf }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = getJob(params.id);
    if (!job) {
      reply.code(404).send({ error: "任务不存在" });
      return;
    }
    if (!userCanOperateJob(request.user, job.submittedBy, "jobs.cancel")) {
      sendForbidden(reply);
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

  app.get("/api/schedules", { preHandler: requireAuth }, async (request) => ({
    schedules: listSchedules(
      hasPermission(request.user?.permissions, "jobs.viewAll") ? undefined : { ownerUsername: request.user?.username },
    ),
  }));

  app.post("/api/schedules", { preHandler: requireCsrf }, async (request, reply) => {
    if (!hasPermission(request.user?.permissions, "jobs.create")) {
      sendForbidden(reply);
      return;
    }

    const catalog = await listCursorModels();
    const body = createScheduleSchema.parse(request.body);
    try {
      const project = await resolveWritableProject(request.user, body.projectId);
      const extraProjects = await resolveExtraProjects(body.extraProjectIds, project.id);
      if (extraProjects.some((item) => !userCanUseProject(request.user, item.id))) {
        sendForbidden(reply, "没有该项目的使用权限");
        return;
      }

      const runOptions = resolveRunOptions({
        loadLocalSettings: body.loadLocalSettings,
        sandbox: body.sandbox,
        autoReview: body.autoReview,
        disallowedTools: sanitizeToolNames(body.disallowedTools),
        extraProjects,
      });

      const schedule = createSchedule({
        name: body.name,
        ownerUsername: request.user?.username ?? config.adminUsername,
        project,
        enabled: body.enabled,
        kind: body.kind,
        simple: body.simple,
        cronExpr: body.cronExpr,
        prompt: body.prompt,
        resumeLast: body.resumeLast,
        runOptions: {
          mode: body.mode ?? config.cursorDefaultMode,
          model: normalizeModelSelection(body.model, catalog),
          extraProjects: runOptions.extraProjects,
          loadLocalSettings: runOptions.loadLocalSettings,
          sandbox: runOptions.sandbox,
          autoReview: runOptions.autoReview,
          disallowedTools: runOptions.disallowedTools,
        },
      });
      reply.code(201).send({ schedule });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === "没有该项目的使用权限" ? 403 : 400;
      reply.code(code).send({ error: message });
    }
  });

  app.patch("/api/schedules/:id", { preHandler: requireCsrf }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = getSchedule(params.id);
    if (!existing) {
      reply.code(404).send({ error: "定时规则不存在" });
      return;
    }
    if (!userCanManageSchedule(request.user, existing.ownerUsername)) {
      sendForbidden(reply);
      return;
    }

    const catalog = await listCursorModels();
    const body = patchScheduleSchema.parse(request.body);
    const definedKeys = Object.entries(body)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (definedKeys.length === 1 && definedKeys[0] === "enabled") {
      try {
        return { schedule: updateSchedule(existing.id, { enabled: body.enabled }) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.code(message === "定时规则不存在" ? 404 : 400).send({ error: message });
        return;
      }
    }

    try {
      const projectId = body.projectId ?? existing.project.id;
      const project = body.projectId ? await resolveWritableProject(request.user, body.projectId) : existing.project;
      const extraIds = body.extraProjectIds ?? existing.runOptions.extraProjects?.map((item) => item.id);
      const extraProjects = await resolveExtraProjects(extraIds, projectId);
      if (extraProjects.some((item) => !userCanUseProject(request.user, item.id))) {
        sendForbidden(reply, "没有该项目的使用权限");
        return;
      }

      const owner = getUserByUsername(existing.ownerUsername);
      if (owner && !owner.disabled) {
        const ownerAccess = {
          username: owner.username,
          permissions: resolvePermissions(owner.role, owner.grants, owner.denies),
          allowedProjectIds: owner.allowedProjectIds,
        };
        if (!userCanUseProject(ownerAccess, projectId)) {
          sendForbidden(reply, "属主没有该项目的使用权限");
          return;
        }
        if (extraProjects.some((item) => !userCanUseProject(ownerAccess, item.id))) {
          sendForbidden(reply, "属主没有附加工作区的使用权限");
          return;
        }
      }

      const runTouched =
        body.projectId !== undefined ||
        body.mode !== undefined ||
        body.model !== undefined ||
        body.extraProjectIds !== undefined ||
        body.loadLocalSettings !== undefined ||
        body.sandbox !== undefined ||
        body.autoReview !== undefined ||
        body.disallowedTools !== undefined;

      const runOptions = runTouched
        ? {
            ...resolveRunOptions({
              loadLocalSettings: body.loadLocalSettings ?? existing.runOptions.loadLocalSettings,
              sandbox: body.sandbox ?? existing.runOptions.sandbox,
              autoReview: body.autoReview ?? existing.runOptions.autoReview,
              disallowedTools: body.disallowedTools
                ? sanitizeToolNames(body.disallowedTools)
                : existing.runOptions.disallowedTools,
              extraProjects,
            }),
            mode: body.mode ?? existing.runOptions.mode,
            model:
              body.model !== undefined
                ? normalizeModelSelection(body.model, catalog)
                : existing.runOptions.model,
          }
        : existing.runOptions;

      const schedule = updateSchedule(existing.id, {
        name: body.name,
        project: body.projectId ? project : undefined,
        enabled: body.enabled,
        kind: body.kind,
        simple: body.simple,
        cronExpr: body.cronExpr,
        prompt: body.prompt,
        resumeLast: body.resumeLast,
        runOptions: runTouched ? runOptions : undefined,
      });
      return { schedule };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === "定时规则不存在" ? 404 : message === "没有该项目的使用权限" ? 403 : 400;
      reply.code(code).send({ error: message });
    }
  });

  app.delete("/api/schedules/:id", { preHandler: requireCsrf }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = getSchedule(params.id);
    if (!existing) {
      reply.code(404).send({ error: "定时规则不存在" });
      return;
    }
    if (!userCanManageSchedule(request.user, existing.ownerUsername)) {
      sendForbidden(reply);
      return;
    }
    deleteSchedule(existing.id);
    return { ok: true };
  });

  app.post("/api/schedules/:id/run", { preHandler: requireCsrf }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = getSchedule(params.id);
    if (!existing) {
      reply.code(404).send({ error: "定时规则不存在" });
      return;
    }
    if (!userCanManageSchedule(request.user, existing.ownerUsername)) {
      sendForbidden(reply);
      return;
    }

    try {
      const result = await triggerSchedule(existing.id, { manual: true });
      if (!result) {
        reply.code(400).send({ error: "触发失败" });
        return;
      }
      reply.code(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ScheduleTriggerError ? error.statusCode : 400;
      reply.code(status).send({ error: message });
    }
  });

  app.get("/api/users", { preHandler: [requireAuth, requirePermission("users.manage")] }, async () => ({
    users: listUsers(),
  }));

  app.post("/api/users", { preHandler: [requireCsrf, requirePermission("users.manage")] }, async (request, reply) => {
    const body = createUserSchema.parse(request.body);
    if (!isRole(body.role)) {
      reply.code(400).send({ error: "角色无效" });
      return;
    }

    const password = body.password?.trim() ? body.password : generateRandomPassword();
    try {
      assertPasswordStrength(password);
      const user = createUser({
        username: body.username,
        passwordHash: generatePasswordHash(password),
        role: body.role,
        grants: sanitizePermissions(body.grants),
        denies: sanitizePermissions(body.denies),
        allowedProjectIds: body.allowedProjectIds,
      });
      return {
        user: toPublicUser(user),
        password: body.password?.trim() ? undefined : password,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
    }
  });

  app.patch("/api/users/:id", { preHandler: [requireCsrf, requirePermission("users.manage")] }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = patchUserSchema.parse(request.body);
    try {
      const user = updateUser(params.id, {
        role: body.role,
        grants: body.grants === undefined ? undefined : sanitizePermissions(body.grants),
        denies: body.denies === undefined ? undefined : sanitizePermissions(body.denies),
        allowedProjectIds: body.allowedProjectIds,
        disabled: body.disabled,
      });
      if (body.disabled) deleteUserSessions(user.id);
      return { user: toPublicUser(user) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === "用户不存在" ? 404 : 400;
      reply.code(code).send({ error: message });
    }
  });

  app.post("/api/users/:id/password", { preHandler: [requireCsrf, requirePermission("users.manage")] }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = adminPasswordSchema.parse(request.body);
    const password = body.password?.trim() ? body.password : generateRandomPassword();
    try {
      assertPasswordStrength(password);
      const user = updateUser(params.id, { passwordHash: generatePasswordHash(password) });
      deleteUserSessions(user.id);
      return {
        ok: true,
        password: body.password?.trim() ? undefined : password,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message === "用户不存在" ? 404 : 400;
      reply.code(code).send({ error: message });
    }
  });

  app.post("/api/me/password", { preHandler: requireCsrf }, async (request, reply) => {
    const body = selfPasswordSchema.parse(request.body);
    const current = request.user ? getUserById(request.user.id) : undefined;
    if (!current) {
      reply.code(401).send({ error: "未登录" });
      return;
    }
    if (!verifyPassword(body.currentPassword, current.passwordHash)) {
      reply.code(400).send({ error: "当前密码不正确" });
      return;
    }
    try {
      assertPasswordStrength(body.newPassword);
      updateUser(current.id, { passwordHash: generatePasswordHash(body.newPassword) });
      deleteUserSessions(current.id, request.sessionId);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
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

  app.addHook("onClose", async () => {
    stopScheduler();
    await flushJobs();
  });

  await app.listen({ host: config.host, port: config.port });
  startScheduler();
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
