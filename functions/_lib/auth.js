/* ============================================================================
   Authentication: password login, signed session cookie, login rate limiting.
   Secrets stay in environment variables (ADMIN_PASSWORD / SESSION_SECRET) and
   never reach the browser.

   Rate limiting is deliberately simple but must be *self-healing*: an expired
   lockout row is deleted on sight, so it can never re-arm itself with a stale
   count and keep a legitimate admin out forever.
   ========================================================================== */

export const COOKIE_NAME = "admin_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

export const MAX_ATTEMPTS = 5;
export const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const BLOCK_MS = 10 * 60 * 1000; // lockout resets itself after 10 minutes

const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function textToBase64Url(text) {
  return bytesToBase64Url(encoder.encode(text));
}

export function sessionSecret(env) {
  return env.SESSION_SECRET || env.ADMIN_PASSWORD || "";
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return new Uint8Array(digest);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* Compares in constant time by hashing both values first. */
export async function passwordMatches(candidate, expected) {
  if (!expected) return false;
  const [left, right] = await Promise.all([sha256(String(candidate || "")), sha256(String(expected))]);
  return timingSafeEqualBytes(left, right);
}

export async function createSessionToken(env) {
  const secret = sessionSecret(env);
  if (!secret) throw new Error("ADMIN_PASSWORD or SESSION_SECRET is not set");
  const payload = {
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
    iat: Date.now()
  };
  const body = textToBase64Url(JSON.stringify(payload));
  const signature = await hmac(secret, body);
  return `${body}.${signature}`;
}

export async function verifySessionToken(env, token) {
  const secret = sessionSecret(env);
  if (!secret || typeof token !== "string" || !token.includes(".")) return false;
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(signature, expected)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
    return Number(payload.exp) > Date.now();
  } catch (error) {
    return false;
  }
}

export function readCookie(header, name) {
  if (!header) return "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : "";
}

export function isLocalRequest(request) {
  try {
    const { hostname } = new URL(request.url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
  } catch (error) {
    return false;
  }
}

export function sessionCookie(request, token) {
  // Secure everywhere except plain-HTTP local development, where browsers drop it.
  // HttpOnly + SameSite=Lax keep the cookie away from scripts and cross-site forms.
  const secure = isLocalRequest(request) ? "" : "; Secure";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearedSessionCookie(request) {
  const secure = isLocalRequest(request) ? "" : "; Secure";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/* True when the request carries a valid admin session and passes the
   same-origin / custom-header checks used for state-changing calls. */
export async function isAdminRequest({ request, env }) {
  const token = readCookie(request.headers.get("cookie") || "", COOKIE_NAME);
  if (!(await verifySessionToken(env, token))) return false;

  if (request.method === "GET" || request.method === "HEAD") return true;

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) return false;
    } catch (error) {
      return false;
    }
  }

  // Custom header means a cross-site HTML form cannot forge a mutation.
  return request.headers.get("x-requested-with") === "admin";
}

export function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

/* ---- login throttling (D1 table login_attempts) ------------------------- */
/* A single row per IP. `first_at` anchors the counting window, `blocked_until`
   is an absolute epoch-ms deadline. Both are always refreshed/deleted so an
   old row can never lock an admin out indefinitely. */

export async function clearLoginFailures(env, ip) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}

export async function checkRateLimit(env, ip) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT count, first_at, blocked_until FROM login_attempts WHERE ip = ?"
  ).bind(ip).first();

  if (!row) return { allowed: true, retryAfter: 0, retryMinutes: 0, attempts: 0, locked: false };

  const blockedUntil = Number(row.blocked_until) || 0;
  const firstAt = Number(row.first_at) || 0;
  const attempts = Number(row.count) || 0;

  if (blockedUntil > now) {
    const retryAfter = Math.ceil((blockedUntil - now) / 1000);
    return {
      allowed: false,
      retryAfter,
      retryMinutes: Math.max(1, Math.ceil(retryAfter / 60)),
      attempts,
      locked: true
    };
  }

  /* Self-healing: an expired lockout or an expired counting window is removed
     immediately, so the next failure starts a fresh window instead of
     inheriting count=5 and instantly re-arming the block. */
  if (blockedUntil || now - firstAt > WINDOW_MS) {
    await clearLoginFailures(env, ip);
    return { allowed: true, retryAfter: 0, retryMinutes: 0, attempts: 0, locked: false };
  }

  return { allowed: true, retryAfter: 0, retryMinutes: 0, attempts, locked: false };
}

export async function recordLoginFailure(env, ip) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT count, first_at FROM login_attempts WHERE ip = ?"
  ).bind(ip).first();

  /* Start a new window when there is no row, or the previous one has expired. */
  if (!row || now - Number(row.first_at || 0) > WINDOW_MS) {
    await env.DB.prepare(
      "INSERT INTO login_attempts (ip, count, first_at, blocked_until) VALUES (?, 1, ?, 0) " +
        "ON CONFLICT(ip) DO UPDATE SET count = 1, first_at = excluded.first_at, blocked_until = 0"
    ).bind(ip, now).run();
    return { attempts: 1, locked: false, retryAfter: 0 };
  }

  const count = Number(row.count || 0) + 1;
  const locked = count >= MAX_ATTEMPTS;
  const blockedUntil = locked ? now + BLOCK_MS : 0;
  /* Anchoring first_at to the block start makes the window and the lockout
     expire together — no 30-minute lockout from a 15-minute window. */
  const firstAt = locked ? now : Number(row.first_at || now);
  await env.DB.prepare(
    "UPDATE login_attempts SET count = ?, first_at = ?, blocked_until = ? WHERE ip = ?"
  ).bind(count, firstAt, blockedUntil, ip).run();
  return {
    attempts: count,
    locked,
    retryAfter: locked ? Math.ceil(BLOCK_MS / 1000) : 0
  };
}

/* Read-only snapshot for /api/health — never returns a password or a token. */
export async function rateLimitStatus(env, ip) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT count, first_at, blocked_until FROM login_attempts WHERE ip = ?"
  ).bind(ip).first();
  const blockedUntil = Number(row && row.blocked_until) || 0;
  const locked = blockedUntil > now;
  return {
    ipKnown: Boolean(row),
    attempts: Number(row && row.count) || 0,
    locked,
    retryMinutes: locked ? Math.max(1, Math.ceil((blockedUntil - now) / 60000)) : 0,
    windowMinutes: Math.round(WINDOW_MS / 60000),
    blockMinutes: Math.round(BLOCK_MS / 60000),
    maxAttempts: MAX_ATTEMPTS
  };
}

export const LOGIN_LIMITS = {
  maxAttempts: MAX_ATTEMPTS,
  windowMs: WINDOW_MS,
  blockMs: BLOCK_MS,
  sessionTtlSeconds: SESSION_TTL_SECONDS
};
