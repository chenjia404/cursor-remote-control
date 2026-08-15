import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { SettingSource, ToolName } from "@cursor/sdk";

dotenv.config();

const appRoot = process.cwd();

function readAppVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(20267),
  PUBLIC_BASE_URL: z.string().optional().default(""),
  CURSOR_API_KEY: z.string().min(1).optional(),
  CURSOR_MODEL: z.string().default("auto"),
  CURSOR_DEFAULT_MODE: z.enum(["agent", "plan"]).default("agent"),
  CURSOR_SETTING_SOURCES: z.string().default("project,user,plugins"),
  CURSOR_SANDBOX: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  CURSOR_AUTO_REVIEW: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  CURSOR_DISALLOWED_TOOLS: z.string().optional().default(""),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  PROJECT_ROOTS: z.string().default("E:\\code;D:\\code;C:\\code"),

  DATA_DIR: z.string().default("./data"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((value): boolean | undefined => (value === undefined ? undefined : value === "true")),
  ENABLE_TOTP: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

const env = envSchema.parse(process.env);

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

const SETTING_SOURCE_VALUES = new Set<SettingSource>(["project", "user", "team", "mdm", "plugins", "all"]);
const KNOWN_TOOL_VALUES = new Set<string>([
  "shell",
  "read",
  "edit",
  "grep",
  "glob",
  "ls",
  "task",
  "mcp",
  "webSearch",
  "delete",
  "readLints",
  "webFetch",
  "semSearch",
  "updateTodos",
  "readTodos",
  "askQuestion",
  "await",
  "generateImage",
  "applyAgentDiff",
]);

function parseSettingSources(raw: string): SettingSource[] {
  const items = raw
    .split(/[,;]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (items.includes("all")) return ["all"];
  const next = items.filter((item): item is SettingSource => SETTING_SOURCE_VALUES.has(item as SettingSource));
  return next.length ? [...new Set(next)] : ["project", "user", "plugins"];
}

function parseToolNames(raw: string): ToolName[] {
  const next: ToolName[] = [];
  for (const item of raw.split(/[,;]/).map((value) => value.trim()).filter(Boolean)) {
    if (!KNOWN_TOOL_VALUES.has(item)) continue;
    if (!next.includes(item as ToolName)) next.push(item as ToolName);
  }
  return next;
}

function publicBaseUrlIsHttps(publicBaseUrl: string): boolean {
  try {
    return Boolean(publicBaseUrl && new URL(publicBaseUrl).protocol === "https:");
  } catch {
    return false;
  }
}

/**
 * 本服务通常只监听 HTTP，公网 HTTPS 由反代终止。
 * Cookie Secure 应在「用户侧是 HTTPS」时开启，而不是看 Node 监听协议。
 */
function resolveCookieSecure(): boolean {
  if (env.COOKIE_SECURE !== undefined) return env.COOKIE_SECURE;
  if (publicBaseUrlIsHttps(env.PUBLIC_BASE_URL)) return true;
  return env.NODE_ENV === "production";
}

export const config = {
  appRoot,
  appVersion: readAppVersion(),
  isProduction: env.NODE_ENV === "production",
  host: env.HOST,
  port: env.PORT,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  publicBaseUrlIsHttps: publicBaseUrlIsHttps(env.PUBLIC_BASE_URL),
  cursorApiKey: env.CURSOR_API_KEY,
  cursorModel: env.CURSOR_MODEL,
  cursorDefaultMode: env.CURSOR_DEFAULT_MODE,
  cursorSettingSources: parseSettingSources(env.CURSOR_SETTING_SOURCES),
  cursorSandbox: env.CURSOR_SANDBOX,
  cursorAutoReview: env.CURSOR_AUTO_REVIEW,
  cursorDisallowedTools: parseToolNames(env.CURSOR_DISALLOWED_TOOLS),
  adminUsername: env.ADMIN_USERNAME,
  adminPasswordHash: env.ADMIN_PASSWORD_HASH,
  sessionSecret: env.SESSION_SECRET,
  projectRoots: env.PROJECT_ROOTS.split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(resolveFromRoot),
  dataDir: resolveFromRoot(env.DATA_DIR),
  cookieSecure: resolveCookieSecure(),
  enableTotp: env.ENABLE_TOTP ?? false,
};

export function assertRequiredConfig(): void {
  const missing: string[] = [];

  if (!config.cursorApiKey) missing.push("CURSOR_API_KEY");
  if (!config.sessionSecret) missing.push("SESSION_SECRET");

  if (missing.length > 0) {
    throw new Error(
      `缺少必要配置：${missing.join(", ")}。请先复制 .env.example 为 .env，并运行 pnpm init-admin。`,
    );
  }
}
