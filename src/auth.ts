import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

const SESSION_COOKIE = "crc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

type SessionPayload = {
  username: string;
  expiresAt: number;
  csrfToken: string;
};

export type AuthenticatedUser = {
  username: string;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    csrfToken?: string;
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

export function issueSession(reply: FastifyReply, username: string): string {
  const payload: SessionPayload = {
    username,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    csrfToken: crypto.randomBytes(24).toString("base64url"),
  };
  const encoded = base64url(JSON.stringify(payload));
  const cookieValue = `${encoded}.${sign(encoded)}`;

  reply.setCookie(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return payload.csrfToken;
}

export function clearSession(reply: FastifyReply): void {
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
    if (payload.expiresAt < Date.now()) return null;
    if (payload.username !== config.adminUsername) return null;
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
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}
