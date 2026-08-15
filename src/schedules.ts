import crypto from "node:crypto";
import { Cron } from "croner";
import type { ToolName } from "@cursor/sdk";
import { getDb, withTransaction } from "./db.js";
import type { AgentMode } from "./jobs.js";
import type { AgentModelSelection } from "./models.js";
import type { ExtraProjectRef } from "./agentOptions.js";
import type { ProjectInfo } from "./projects.js";

export type ScheduleKind = "simple" | "cron";
export type SimpleFrequency = "daily" | "weekly" | "monthly" | "interval";

export type SimpleSchedule = {
  frequency: SimpleFrequency;
  /** 每天 / 每周 / 每月 的本地时刻，HH:MM */
  time?: string;
  /** 0=周日 … 6=周六，与标准 5 段 Cron 一致 */
  weekdays?: number[];
  /** 每月几号，1–31；没有该日的月份会跳过 */
  monthDay?: number;
  intervalHours?: number;
};

export type ScheduleRunOptions = {
  mode: AgentMode;
  model?: AgentModelSelection;
  extraProjects?: ExtraProjectRef[];
  loadLocalSettings?: boolean;
  sandbox?: boolean;
  autoReview?: boolean;
  disallowedTools?: ToolName[];
};

export type ScheduleRecord = {
  id: string;
  name: string;
  enabled: boolean;
  ownerUsername: string;
  project: Pick<ProjectInfo, "id" | "name" | "path">;
  kind: ScheduleKind;
  simple?: SimpleSchedule;
  cronExpr?: string;
  timezone: string;
  prompt: string;
  resumeLast: boolean;
  runOptions: ScheduleRunOptions;
  nextRunAt?: string;
  lastRunAt?: string;
  lastJobId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleInput = {
  name: string;
  project: Pick<ProjectInfo, "id" | "name" | "path">;
  enabled?: boolean;
  kind: ScheduleKind;
  simple?: SimpleSchedule;
  cronExpr?: string;
  prompt: string;
  resumeLast?: boolean;
  runOptions: ScheduleRunOptions;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const CRON_FIELD_PATTERN = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168;

type ScheduleRow = {
  id: string;
  owner_username: string;
  enabled: number;
  project_id: string;
  project_name: string;
  project_path: string;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  record_json: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function parseTime(value: string | undefined): { hour: number; minute: number } {
  const raw = String(value || "").trim();
  const match = TIME_PATTERN.exec(raw);
  if (!match) {
    throw new Error("请填写有效的执行时刻，格式为 HH:MM");
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function normalizeMonthDay(input: unknown): number {
  const day = Number(input);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error("请填写每月的执行日，范围为 1 到 31");
  }
  return day;
}

function uniqueWeekdays(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const next: number[] = [];
  for (const item of input) {
    const day = Number(item);
    if (!Number.isInteger(day) || day < 0 || day > 6 || next.includes(day)) continue;
    next.push(day);
  }
  return next.sort((left, right) => left - right);
}

function assertCronExpression(expr: string, timezone: string): string {
  const normalized = expr.trim().replace(/\s+/g, " ");
  if (!CRON_FIELD_PATTERN.test(normalized)) {
    throw new Error("Cron 表达式需为 5 段，例如 0 3 * * 1");
  }
  try {
    const cron = new Cron(normalized, { timezone, paused: true, mode: "5-part" });
    if (!cron.nextRun()) {
      throw new Error("无法计算下次执行时间");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cron 表达式")) throw error;
    if (error instanceof Error && error.message === "无法计算下次执行时间") throw error;
    throw new Error("无效的 Cron 表达式");
  }
  return normalized;
}

function toCronExpression(schedule: Pick<ScheduleRecord, "kind" | "simple" | "cronExpr">): string {
  if (schedule.kind === "cron") {
    return String(schedule.cronExpr || "").trim();
  }

  const simple = schedule.simple;
  if (!simple || simple.frequency === "interval") {
    throw new Error("当前周期不使用 Cron");
  }

  const { hour, minute } = parseTime(simple.time);
  if (simple.frequency === "daily") {
    return `${minute} ${hour} * * *`;
  }
  if (simple.frequency === "monthly") {
    return `${minute} ${hour} ${normalizeMonthDay(simple.monthDay)} * *`;
  }

  const weekdays = uniqueWeekdays(simple.weekdays);
  if (weekdays.length === 0) {
    throw new Error("请选择每周的执行日");
  }
  return `${minute} ${hour} * * ${weekdays.join(",")}`;
}

export function computeNextRunAt(schedule: Pick<ScheduleRecord, "kind" | "simple" | "cronExpr" | "timezone">, from = new Date()): string {
  const timezone = schedule.timezone || localTimeZone();

  if (schedule.kind === "simple" && schedule.simple?.frequency === "interval") {
    const hours = Number(schedule.simple.intervalHours);
    if (!Number.isInteger(hours) || hours < MIN_INTERVAL_HOURS || hours > MAX_INTERVAL_HOURS) {
      throw new Error(`间隔小时数需为 ${MIN_INTERVAL_HOURS} 到 ${MAX_INTERVAL_HOURS}`);
    }
    return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
  }

  const expr = toCronExpression(schedule);
  const cron = new Cron(expr, { timezone, paused: true, mode: "5-part" });
  const next = cron.nextRun(new Date(from.getTime() + 1000));
  if (!next) {
    throw new Error("无法计算下次执行时间");
  }
  return next.toISOString();
}

function normalizeSimple(input: SimpleSchedule | undefined): SimpleSchedule {
  const frequency = input?.frequency;
  if (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly" && frequency !== "interval") {
    throw new Error("请选择每天、每周、每月或按小时间隔");
  }

  if (frequency === "interval") {
    const intervalHours = Number(input?.intervalHours);
    if (!Number.isInteger(intervalHours) || intervalHours < MIN_INTERVAL_HOURS || intervalHours > MAX_INTERVAL_HOURS) {
      throw new Error(`间隔小时数需为 ${MIN_INTERVAL_HOURS} 到 ${MAX_INTERVAL_HOURS}`);
    }
    return { frequency, intervalHours };
  }

  const { hour, minute } = parseTime(input?.time);
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (frequency === "weekly") {
    const weekdays = uniqueWeekdays(input?.weekdays);
    if (weekdays.length === 0) {
      throw new Error("请选择每周的执行日");
    }
    return { frequency, time, weekdays };
  }

  if (frequency === "monthly") {
    return { frequency, time, monthDay: normalizeMonthDay(input?.monthDay) };
  }

  return { frequency, time };
}

export function normalizeScheduleFields(input: ScheduleInput, timezone = localTimeZone()): Omit<
  ScheduleRecord,
  "id" | "ownerUsername" | "createdAt" | "updatedAt" | "nextRunAt" | "lastRunAt" | "lastJobId" | "lastError"
> {
  const name = input.name.trim();
  if (!name) throw new Error("规则名称不能为空");
  if (name.length > 80) throw new Error("规则名称不能超过 80 字");

  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("请输入定时任务指令");
  if (prompt.length > 20000) throw new Error("定时任务指令过长");

  const kind = input.kind === "cron" ? "cron" : "simple";
  const simple = kind === "simple" ? normalizeSimple(input.simple) : undefined;
  const cronExpr = kind === "cron" ? assertCronExpression(String(input.cronExpr || ""), timezone) : undefined;

  return {
    name,
    enabled: input.enabled !== false,
    project: {
      id: input.project.id,
      name: input.project.name,
      path: input.project.path,
    },
    kind,
    simple,
    cronExpr,
    timezone,
    prompt,
    resumeLast: Boolean(input.resumeLast),
    runOptions: {
      mode: input.runOptions.mode === "plan" ? "plan" : "agent",
      model: input.runOptions.model,
      extraProjects: input.runOptions.extraProjects,
      loadLocalSettings: input.runOptions.loadLocalSettings,
      sandbox: input.runOptions.sandbox,
      autoReview: input.runOptions.autoReview,
      disallowedTools: input.runOptions.disallowedTools,
    },
  };
}

function rowValues(schedule: ScheduleRecord) {
  return [
    schedule.id,
    schedule.ownerUsername,
    schedule.enabled ? 1 : 0,
    schedule.project.id,
    schedule.project.name,
    schedule.project.path,
    schedule.nextRunAt ?? null,
    schedule.createdAt,
    schedule.updatedAt,
    JSON.stringify(schedule),
  ];
}

function parseRecord(row: ScheduleRow): ScheduleRecord | undefined {
  try {
    const record = JSON.parse(row.record_json) as ScheduleRecord;
    if (!record?.id) return undefined;
    return {
      ...record,
      enabled: Boolean(row.enabled),
      ownerUsername: row.owner_username,
      project: {
        id: row.project_id,
        name: row.project_name,
        path: row.project_path,
      },
      nextRunAt: row.next_run_at ?? record.nextRunAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return undefined;
  }
}

function upsertSchedule(schedule: ScheduleRecord): void {
  getDb()
    .prepare(
      `INSERT INTO schedules (
         id, owner_username, enabled, project_id, project_name, project_path,
         next_run_at, created_at, updated_at, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_username = excluded.owner_username,
         enabled = excluded.enabled,
         project_id = excluded.project_id,
         project_name = excluded.project_name,
         project_path = excluded.project_path,
         next_run_at = excluded.next_run_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         record_json = excluded.record_json`,
    )
    .run(...rowValues(schedule));
}

export function createSchedule(input: ScheduleInput & { ownerUsername: string }): ScheduleRecord {
  const timestamp = nowIso();
  const fields = normalizeScheduleFields(input);
  const schedule: ScheduleRecord = {
    id: crypto.randomUUID(),
    ownerUsername: input.ownerUsername,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...fields,
  };
  schedule.nextRunAt = computeNextRunAt(schedule);
  withTransaction(() => upsertSchedule(schedule));
  return schedule;
}

export function updateSchedule(
  id: string,
  patch: Partial<ScheduleInput> & {
    lastRunAt?: string;
    lastJobId?: string | null;
    lastError?: string | null;
    nextRunAt?: string;
    recomputeNext?: boolean;
  },
): ScheduleRecord {
  const current = getSchedule(id);
  if (!current) throw new Error("定时规则不存在");

  const shouldNormalize =
    patch.name !== undefined ||
    patch.project !== undefined ||
    patch.kind !== undefined ||
    patch.simple !== undefined ||
    patch.cronExpr !== undefined ||
    patch.prompt !== undefined ||
    patch.resumeLast !== undefined ||
    patch.runOptions !== undefined ||
    patch.enabled !== undefined;

  const next: ScheduleRecord = shouldNormalize
    ? {
        ...current,
        ...normalizeScheduleFields({
          name: patch.name ?? current.name,
          project: patch.project ?? current.project,
          enabled: patch.enabled ?? current.enabled,
          kind: patch.kind ?? current.kind,
          simple: patch.simple ?? current.simple,
          cronExpr: patch.cronExpr ?? current.cronExpr,
          prompt: patch.prompt ?? current.prompt,
          resumeLast: patch.resumeLast ?? current.resumeLast,
          runOptions: patch.runOptions ?? current.runOptions,
        }, current.timezone),
        id: current.id,
        ownerUsername: current.ownerUsername,
        createdAt: current.createdAt,
        lastRunAt: current.lastRunAt,
        lastJobId: current.lastJobId,
        lastError: current.lastError,
        nextRunAt: current.nextRunAt,
      }
    : { ...current };

  if (patch.lastRunAt !== undefined) next.lastRunAt = patch.lastRunAt;
  if (patch.lastJobId !== undefined) next.lastJobId = patch.lastJobId ?? undefined;
  if (patch.lastError !== undefined) next.lastError = patch.lastError ?? undefined;
  if (patch.nextRunAt !== undefined) next.nextRunAt = patch.nextRunAt;
  if (patch.project && patch.project.id !== current.project.id && patch.lastJobId === undefined) {
    next.lastJobId = undefined;
  }

  const scheduleChanged =
    patch.kind !== undefined ||
    patch.simple !== undefined ||
    patch.cronExpr !== undefined ||
    (patch.enabled === true && !current.enabled);

  if (patch.recomputeNext || scheduleChanged) {
    next.nextRunAt = computeNextRunAt(next);
  }

  next.updatedAt = nowIso();
  withTransaction(() => upsertSchedule(next));
  return next;
}

export function deleteSchedule(id: string): boolean {
  const result = getDb().prepare("DELETE FROM schedules WHERE id = ?").run(id);
  return Number(result.changes || 0) > 0;
}

export function getSchedule(id: string): ScheduleRecord | undefined {
  const row = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  return row ? parseRecord(row) : undefined;
}

export function listSchedules(filter?: { ownerUsername?: string }): ScheduleRecord[] {
  const rows = (
    filter?.ownerUsername
      ? getDb().prepare("SELECT * FROM schedules WHERE owner_username = ? COLLATE NOCASE").all(filter.ownerUsername)
      : getDb().prepare("SELECT * FROM schedules").all()
  ) as ScheduleRow[];

  return rows
    .map((row) => parseRecord(row))
    .filter((item): item is ScheduleRecord => Boolean(item))
    .sort((left, right) => {
      const leftNext = left.nextRunAt || "";
      const rightNext = right.nextRunAt || "";
      if (leftNext !== rightNext) return leftNext.localeCompare(rightNext);
      return left.name.localeCompare(right.name, "zh-CN");
    });
}

export function listDueSchedules(now = new Date()): ScheduleRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM schedules
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at`,
    )
    .all(now.toISOString()) as ScheduleRow[];

  return rows.map((row) => parseRecord(row)).filter((item): item is ScheduleRecord => Boolean(item));
}

export function markScheduleRun(
  id: string,
  patch: {
    lastJobId?: string;
    lastError?: string | null;
    lastRunAt?: string;
    advanceNext?: boolean;
  },
): ScheduleRecord {
  const current = getSchedule(id);
  if (!current) throw new Error("定时规则不存在");

  let nextRunAt = current.nextRunAt;
  if (patch.advanceNext !== false && current.enabled) {
    try {
      nextRunAt = computeNextRunAt(current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`定时规则 ${current.name} 无法计算下次时间，已延后一小时：${message}`);
      nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
  }

  const next: ScheduleRecord = {
    ...current,
    lastJobId: patch.lastJobId ?? current.lastJobId,
    lastError: patch.lastError === undefined ? current.lastError : (patch.lastError ?? undefined),
    lastRunAt: patch.lastRunAt ?? current.lastRunAt,
    nextRunAt,
    updatedAt: nowIso(),
  };
  withTransaction(() => upsertSchedule(next));
  return next;
}
