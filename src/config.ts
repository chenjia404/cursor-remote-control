import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

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
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  PROJECT_ROOTS: z.string().default("D:\\code"),
  DATA_DIR: z.string().default("./data"),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  ENABLE_TOTP: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

const env = envSchema.parse(process.env);

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

export const config = {
  appRoot,
  appVersion: readAppVersion(),
  isProduction: env.NODE_ENV === "production",
  host: env.HOST,
  port: env.PORT,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  cursorApiKey: env.CURSOR_API_KEY,
  cursorModel: env.CURSOR_MODEL,
  adminUsername: env.ADMIN_USERNAME,
  adminPasswordHash: env.ADMIN_PASSWORD_HASH,
  sessionSecret: env.SESSION_SECRET,
  projectRoots: env.PROJECT_ROOTS.split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(resolveFromRoot),
  dataDir: resolveFromRoot(env.DATA_DIR),
  cookieSecure: env.COOKIE_SECURE ?? env.NODE_ENV === "production",
  enableTotp: env.ENABLE_TOTP ?? false,
};

export function assertRequiredConfig(): void {
  const missing: string[] = [];

  if (!config.cursorApiKey) missing.push("CURSOR_API_KEY");
  if (!config.adminPasswordHash) missing.push("ADMIN_PASSWORD_HASH");
  if (!config.sessionSecret) missing.push("SESSION_SECRET");

  if (missing.length > 0) {
    throw new Error(
      `缺少必要配置：${missing.join(", ")}。请先复制 .env.example 为 .env，并运行 pnpm init-admin。`,
    );
  }
}
