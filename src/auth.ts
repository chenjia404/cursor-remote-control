import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { hasPermission, type Permission } from "./permissions.js";
import { getUserById, getUserByUsername, toPublicUser, type UserRecord } from "./users.js";

const SESSION_COOKIE = "crc_session";
/** 记住登录时长：90 天 */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90;
const MAX_SESSIONS_PER_USER = 10;

type SessionPayload = {
  userId: string;
  username: string;
  sessionId: string;
  expiresAt: number;
  csrfToken: string;
};

type SessionRow = {
  session_id: string;
  user_id: string;
  username: string;
  issued_at: number;
  expires_at: number;
};

export type AuthenticatedUser = {
  id: string;
  username: string;
  role: UserRecord["role"];
  permissions: Permission[];
  allowedProjectIds: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    csrfToken?: string;
    sessionId?: string;
  }
}

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

/**
 * 用户是否通过 HTTPS 访问（反代场景看转发头，而不是 Node 的监听协议）。
 * 本服务常为 HTTP，前面 Cloudflare / Nginx 等以 HTTPS 对外。
 */
export function isHttpsClientRequest(request?: FastifyRequest): boolean {
  if (!request) return config.cookieSecure || config.publicBaseUrlIsHttps;

  // trustProxy: true 时，Fastify 会按 X-Forwarded-Proto 填充 protocol
  if (request.protocol === "https") return true;

  const forwarded = request.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded.split(",")[0].trim().toLowerCase() === "https") {
    return true;
  }
  if (Array.isArray(forwarded) && forwarded[0]?.split(",")[0].trim().toLowerCase() === "https") {
    return true;
  }

  const cfVisitor = request.headers["cf-visitor"];
  if (typeof cfVisitor === "string" && /"scheme"\s*:\s*"https"/i.test(cfVisitor)) {
    return true;
  }

  return config.cookieSecure || config.publicBaseUrlIsHttps;
}

function cookieSecureForRequest(request?: FastifyRequest): boolean {
  return isHttpsClientRequest(request);
}

function pruneExpiredSessions(): void {
  getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

function limitUserSessions(userId: string): void {
  const rows = getDb()
    .prepare("SELECT session_id FROM sessions WHERE user_id = ? ORDER BY issued_at DESC")
    .all(userId) as Array<{ session_id: string }>;
  if (rows.length <= MAX_SESSIONS_PER_USER) return;

  const del = getDb().prepare("DELETE FROM sessions WHERE session_id = ?");
  for (const row of rows.slice(MAX_SESSIONS_PER_USER)) {
    del.run(row.session_id);
  }
}

function insertSession(row: SessionRow): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (session_id, user_id, username, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.session_id, row.user_id, row.username, row.issued_at, row.expires_at);
}

function getStoredSession(sessionId: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined;
}

export function deleteSession(sessionId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
}

export function deleteUserSessions(userId: string, exceptSessionId?: string): void {
  if (exceptSessionId) {
    getDb().prepare("DELETE FROM sessions WHERE user_id = ? AND session_id != ?").run(userId, exceptSessionId);
    return;
  }
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function deleteAllSessions(): void {
  getDb().prepare("DELETE FROM sessions").run();
}

export function toAuthenticatedUser(user: UserRecord): AuthenticatedUser {
  const publicUser = toPublicUser(user);
  return {
    id: publicUser.id,
    username: publicUser.username,
    role: publicUser.role,
    permissions: publicUser.permissions,
    allowedProjectIds: publicUser.allowedProjectIds,
  };
}

export type IssuedSession = {
  csrfToken: string;
  /** 与 Cookie 同值；反代丢弃 Set-Cookie 时可由前端放到 Authorization */
  sessionToken: string;
};

export async function issueSession(
  reply: FastifyReply,
  user: UserRecord,
  request?: FastifyRequest,
): Promise<IssuedSession> {
  pruneExpiredSessions();

  const sessionId = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const payload: SessionPayload = {
    userId: user.id,
    username: user.username,
    sessionId,
    expiresAt,
    csrfToken,
  };
  const encoded = base64url(JSON.stringify(payload));
  const cookieValue = `${encoded}.${sign(encoded)}`;

  insertSession({
    session_id: sessionId,
    user_id: user.id,
    username: user.username,
    issued_at: Date.now(),
    expires_at: expiresAt,
  });
  limitUserSessions(user.id);

  reply.setCookie(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecureForRequest(request),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return { csrfToken, sessionToken: cookieValue };
}

export async function clearSession(
  reply: FastifyReply,
  sessionId?: string,
  request?: FastifyRequest,
): Promise<void> {
  if (sessionId) deleteSession(sessionId);

  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    secure: cookieSecureForRequest(request),
    sameSite: "lax",
  });
}

function readBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }

  const alt = request.headers["x-crc-session"];
  if (typeof alt === "string" && alt.trim()) return alt.trim();
  if (Array.isArray(alt) && alt[0]?.trim()) return alt[0].trim();
  return null;
}

function parseSessionToken(rawToken: string): SessionPayload | null {
  const [encoded, signature] = rawToken.split(".");
  if (!encoded || !signature || sign(encoded) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.sessionId || !payload.userId || payload.expiresAt < Date.now()) return null;

    const stored = getStoredSession(payload.sessionId);
    if (!stored || stored.user_id !== payload.userId || stored.expires_at < Date.now()) {
      return null;
    }

    const user = getUserById(payload.userId) ?? getUserByUsername(payload.username);
    if (!user || user.disabled) return null;

    return {
      ...payload,
      userId: user.id,
      username: user.username,
    };
  } catch {
    return null;
  }
}

function resolveUserFromSession(session: SessionPayload): AuthenticatedUser | null {
  const user = getUserById(session.userId) ?? getUserByUsername(session.username);
  if (!user || user.disabled) return null;
  return toAuthenticatedUser(user);
}

/** 当前请求上的有效会话令牌（Cookie 或 Bearer），供前端持久化以免隔天丢失 */
export function getRawSessionToken(request: FastifyRequest): string | null {
  const rawCookie = request.cookies[SESSION_COOKIE];
  if (rawCookie && parseSessionToken(rawCookie)) return rawCookie;

  const bearer = readBearerToken(request);
  if (bearer && parseSessionToken(bearer)) return bearer;
  return null;
}

export function readSession(request: FastifyRequest): SessionPayload | null {
  const raw = getRawSessionToken(request);
  return raw ? parseSessionToken(raw) : null;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = readSession(request);
  if (!session) {
    reply.code(401).send({ error: "未登录" });
    return;
  }

  const user = resolveUserFromSession(session);
  if (!user) {
    reply.code(401).send({ error: "未登录" });
    return;
  }

  request.user = user;
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

  const user = resolveUserFromSession(session);
  if (!user) {
    reply.code(401).send({ error: "未登录" });
    return;
  }

  request.user = user;
  request.csrfToken = session.csrfToken;
  request.sessionId = session.sessionId;
}

export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (reply.sent) return;
    if (!request.user) {
      await requireAuth(request, reply);
      if (reply.sent) return;
    }

    if (!request.user || !hasPermission(request.user.permissions, permission)) {
      reply.code(403).send({ error: "没有权限" });
    }
  };
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export async function loadActiveSession(): Promise<void> {
  pruneExpiredSessions();
}
