import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

const SESSION_COOKIE = "crc_session";
/** 记住登录时长：90 天 */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90;

type SessionPayload = {
  username: string;
  sessionId: string;
  expiresAt: number;
  csrfToken: string;
};

type ActiveSessionStore = {
  sessionId: string;
  username: string;
  issuedAt: number;
  expiresAt: number;
};

export type AuthenticatedUser = {
  username: string;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    csrfToken?: string;
    sessionId?: string;
  }
}

let activeSession: ActiveSessionStore | null = null;
let activeSessionLoaded = false;
let activeSessionWriteChain = Promise.resolve();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(value: string): string {
  return crypto.createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

function getSessionSecret(): string {
  if (!config.sessionSecret) {
    throw new Error("SESSION_SECRET 未配置");
  }

  return config.sessionSecret;
}

function activeSessionFile(): string {
  return path.join(config.dataDir, "active-session.json");
}

function isActiveSessionValid(session: ActiveSessionStore | null): session is ActiveSessionStore {
  return Boolean(session && session.expiresAt >= Date.now() && session.username === config.adminUsername);
}

async function persistActiveSession(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  if (!activeSession) {
    try {
      await fs.unlink(activeSessionFile());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    return;
  }

  await fs.writeFile(activeSessionFile(), JSON.stringify(activeSession, null, 2), "utf8");
}

function schedulePersistActiveSession(): void {
  activeSessionWriteChain = activeSessionWriteChain.then(persistActiveSession).catch((error) => {
    console.error("保存活动会话失败", error);
  });
}

export async function loadActiveSession(): Promise<void> {
  if (activeSessionLoaded) return;
  activeSessionLoaded = true;

  try {
    const text = await fs.readFile(activeSessionFile(), "utf8");
    const stored = JSON.parse(text) as ActiveSessionStore;
    activeSession = isActiveSessionValid(stored) ? stored : null;
    if (!activeSession) {
      schedulePersistActiveSession();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("读取活动会话失败", error);
    }
    activeSession = null;
  }
}

export function generateRandomPassword(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function generatePasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${derivedKey}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, salt, key] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !key) return false;

  const expected = Buffer.from(key, "base64url");
  const actual = crypto.scryptSync(password, salt, expected.length);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * 签发新会话。同一时刻仅保留一个有效会话，新登录会使其他设备上的旧会话立即失效。
 */
export async function issueSession(reply: FastifyReply, username: string): Promise<string> {
  const sessionId = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const payload: SessionPayload = {
    username,
    sessionId,
    expiresAt,
    csrfToken,
  };
  const encoded = base64url(JSON.stringify(payload));
  const cookieValue = `${encoded}.${sign(encoded)}`;

  activeSession = {
    sessionId,
    username,
    issuedAt: Date.now(),
    expiresAt,
  };
  await persistActiveSession();

  reply.setCookie(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return csrfToken;
}

export async function clearSession(reply: FastifyReply, sessionId?: string): Promise<void> {
  if (activeSession && (!sessionId || activeSession.sessionId === sessionId)) {
    activeSession = null;
    await persistActiveSession();
  }

  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    secure: config.cookieSecure,
    sameSite: "lax",
  });
}

export function readSession(request: FastifyRequest): SessionPayload | null {
  const rawCookie = request.cookies[SESSION_COOKIE];
  if (!rawCookie) return null;

  const [encoded, signature] = rawCookie.split(".");
  if (!encoded || !signature || sign(encoded) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.sessionId || payload.expiresAt < Date.now()) return null;
    if (payload.username !== config.adminUsername) return null;
    if (!isActiveSessionValid(activeSession) || activeSession.sessionId !== payload.sessionId) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = readSession(request);
  if (!session) {
    reply.code(401).send({ error: "未登录" });
    return;
  }

  request.user = { username: session.username };
  request.csrfToken = session.csrfToken;
  request.sessionId = session.sessionId;
}

export async function requireCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = readSession(request);
  if (!session) {
    reply.code(401).send({ error: "未登录" });
    return;
  }

  const token = request.headers["x-csrf-token"];
  if (typeof token !== "string" || token !== session.csrfToken) {
    reply.code(403).send({ error: "CSRF 校验失败" });
    return;
  }

  request.user = { username: session.username };
  request.csrfToken = session.csrfToken;
  request.sessionId = session.sessionId;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}
