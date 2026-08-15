import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { deleteAllSessions } from "../src/auth.js";
import { initDatabase } from "../src/db.js";
import { generatePasswordHash, generateRandomPassword } from "../src/passwords.js";
import { upsertAdminUser } from "../src/users.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectRoot, ".env");
const examplePath = path.join(projectRoot, ".env.example");

function loadEnvText(): string {
  if (fs.existsSync(envPath)) return fs.readFileSync(envPath, "utf8");
  return fs.readFileSync(examplePath, "utf8");
}

function upsertEnvValue(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.trimEnd()}\n${line}\n`;
}

const password = generateRandomPassword();
const passwordHash = generatePasswordHash(password);
let envText = loadEnvText();
envText = upsertEnvValue(envText, "ADMIN_USERNAME", "admin");
envText = upsertEnvValue(envText, "ADMIN_PASSWORD_HASH", passwordHash);
envText = upsertEnvValue(envText, "SESSION_SECRET", crypto.randomBytes(48).toString("base64url"));

fs.writeFileSync(envPath, envText, { encoding: "utf8", flag: "w" });

initDatabase();
upsertAdminUser("admin", passwordHash);
deleteAllSessions();

console.log("管理员初始化完成。请立即保存下面的密码，它不会再次显示。");
console.log(`用户名：admin`);
console.log(`密码：${password}`);
console.log(`配置文件：${envPath}`);
console.log("已写入 SQLite 管理员并清除旧登录会话，请使用新密码重新登录。");
