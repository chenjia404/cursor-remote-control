import { userCanUseProject, type AccessUser } from "./access.js";
import { resolveExtraProjects, resolveRunOptions } from "./agentOptions.js";
import { scheduleConversation } from "./cursorAgent.js";
import { createJob, enqueueJobTurn, getJob } from "./jobs.js";
import { listCursorModels, normalizeModelSelection } from "./models.js";
import { hasPermission, resolvePermissions } from "./permissions.js";
import { getProjectById, isProjectSelected } from "./projects.js";
import {
  getSchedule,
  listDueSchedules,
  markScheduleRun,
  type ScheduleRecord,
} from "./schedules.js";
import { getUserByUsername } from "./users.js";

const TICK_MS = 20_000;
const SOURCE_IP = "scheduler";

const firingIds = new Set<string>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export class ScheduleTriggerError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ScheduleTriggerError";
    this.statusCode = statusCode;
  }
}

function ownerAccess(username: string): AccessUser {
  const user = getUserByUsername(username);
  if (!user) {
    throw new ScheduleTriggerError("规则属主不存在", 400);
  }
  if (user.disabled) {
    throw new ScheduleTriggerError("规则属主已停用", 400);
  }
  return {
    username: user.username,
    permissions: resolvePermissions(user.role, user.grants, user.denies),
    allowedProjectIds: user.allowedProjectIds,
  };
}

function isJobBusy(jobId: string | undefined): boolean {
  if (!jobId) return false;
  const job = getJob(jobId);
  if (!job) return false;
  return job.status === "queued" || job.status === "running";
}

async function launchFromSchedule(schedule: ScheduleRecord) {
  const owner = ownerAccess(schedule.ownerUsername);

  if (!(await isProjectSelected(schedule.project.id))) {
    throw new ScheduleTriggerError("项目已不再是已确认项目", 400);
  }
  if (!userCanUseProject(owner, schedule.project.id)) {
    throw new ScheduleTriggerError("属主没有该项目的使用权限", 403);
  }

  const project = await getProjectById(schedule.project.id);
  const extraProjects = await resolveExtraProjects(
    (schedule.runOptions.extraProjects ?? []).map((item) => item.id),
    project.id,
  );
  if (extraProjects.some((item) => !userCanUseProject(owner, item.id))) {
    throw new ScheduleTriggerError("属主没有附加工作区的使用权限", 403);
  }

  const catalog = await listCursorModels();
  const model = normalizeModelSelection(schedule.runOptions.model, catalog);
  const runOptions = resolveRunOptions({
    loadLocalSettings: schedule.runOptions.loadLocalSettings,
    sandbox: schedule.runOptions.sandbox,
    autoReview: schedule.runOptions.autoReview,
    disallowedTools: schedule.runOptions.disallowedTools,
    extraProjects,
  });

  const lastJob = schedule.resumeLast && schedule.lastJobId ? getJob(schedule.lastJobId) : undefined;
  const canResume = Boolean(
    lastJob?.agentId &&
      lastJob.project.id === schedule.project.id &&
      lastJob.submittedBy.trim().toLowerCase() === schedule.ownerUsername.trim().toLowerCase() &&
      hasPermission(owner.permissions, "jobs.followUp"),
  );
  if (lastJob && canResume) {
    const { job } = enqueueJobTurn(lastJob.id, {
      prompt: schedule.prompt,
      mode: schedule.runOptions.mode,
      model,
      loadLocalSettings: runOptions.loadLocalSettings,
      sandbox: runOptions.sandbox,
      autoReview: runOptions.autoReview,
      disallowedTools: runOptions.disallowedTools,
      extraProjects: runOptions.extraProjects,
    });
    scheduleConversation(job.id);
    return job;
  }

  if (!hasPermission(owner.permissions, "jobs.create")) {
    throw new ScheduleTriggerError("规则属主没有新建任务的权限", 403);
  }

  const job = createJob({
    project,
    prompt: schedule.prompt,
    submittedBy: schedule.ownerUsername,
    sourceIp: SOURCE_IP,
    mode: schedule.runOptions.mode,
    model,
    extraProjects: runOptions.extraProjects,
    loadLocalSettings: runOptions.loadLocalSettings,
    sandbox: runOptions.sandbox,
    autoReview: runOptions.autoReview,
    disallowedTools: runOptions.disallowedTools,
    scheduleId: schedule.id,
  });
  scheduleConversation(job.id);
  return job;
}

export async function triggerSchedule(id: string, options?: { manual?: boolean }) {
  const schedule = getSchedule(id);
  if (!schedule) {
    throw new ScheduleTriggerError("定时规则不存在", 404);
  }
  if (firingIds.has(schedule.id)) {
    throw new ScheduleTriggerError("规则正在触发", 409);
  }
  firingIds.add(schedule.id);
  try {
    const latest = getSchedule(schedule.id) ?? schedule;
    if (!options?.manual && !latest.enabled) {
      return undefined;
    }
    if (isJobBusy(latest.lastJobId)) {
      if (!options?.manual) {
        markScheduleRun(latest.id, {
          lastError: "上一轮任务仍在进行，已跳过本轮",
        });
      }
      throw new ScheduleTriggerError("上一轮任务仍在进行，已跳过本轮", 409);
    }
    const job = await launchFromSchedule(latest);
    const due = Boolean(latest.nextRunAt && latest.nextRunAt <= new Date().toISOString());
    return {
      job,
      schedule: markScheduleRun(latest.id, {
        lastJobId: job.id,
        lastRunAt: new Date().toISOString(),
        lastError: null,
        advanceNext: !options?.manual || due,
      }),
    };
  } catch (error) {
    if (error instanceof ScheduleTriggerError && error.statusCode === 409) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    markScheduleRun(schedule.id, {
      lastError: message,
      advanceNext: !options?.manual,
    });
    if (options?.manual) {
      throw error instanceof ScheduleTriggerError ? error : new ScheduleTriggerError(message, 400);
    }
    console.warn(`定时规则 ${schedule.name} 触发失败：${message}`);
    return undefined;
  } finally {
    firingIds.delete(schedule.id);
  }
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const due = listDueSchedules();
    for (const schedule of due) {
      try {
        await triggerSchedule(schedule.id);
      } catch (error) {
        if (error instanceof ScheduleTriggerError && error.statusCode === 409) {
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`定时规则 ${schedule.name} 触发失败：${message}`);
      }
    }
  } catch (error) {
    console.error("定时调度器本轮检查失败", error);
  } finally {
    tickInFlight = false;
  }
}

export function startScheduler(): void {
  if (tickTimer) return;
  void tick();
  tickTimer = setInterval(() => {
    void tick();
  }, TICK_MS);
  tickTimer.unref?.();
}

export function stopScheduler(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}
