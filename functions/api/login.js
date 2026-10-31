/* POST /api/login  { password } -> sets the HttpOnly admin session cookie. */

import {
  checkRateLimit,
  clearLoginFailures,
  clientIp,
  createSessionToken,
  passwordMatches,
  recordLoginFailure,
  sessionCookie
} from "../_lib/auth.js";
import { ensureSchema } from "../_lib/db.js";
import { fail, json } from "../_lib/http.js";

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) {
    return fail("Admin login is not configured: set the ADMIN_PASSWORD environment variable.", 503);
  }

  await ensureSchema(env);

  const ip = clientIp(request);
  const limit = await checkRateLimit(env, ip);
  if (!limit.allowed) {
    return fail("Too many attempts. Please wait and try again.", 429, {
      "retry-after": String(limit.retryAfter)
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return fail("Invalid JSON body");
  }

  const password = typeof body.password === "string" ? body.password.slice(0, 512) : "";
  if (!password) return fail("Password is required", 422);

  if (!(await passwordMatches(password, env.ADMIN_PASSWORD))) {
    await recordLoginFailure(env, ip);
    return fail("Incorrect password", 401);
  }

  await clearLoginFailures(env, ip);
  const token = await createSessionToken(env);

  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, token) });
}

export function onRequestGet() {
  return fail("Method not allowed", 405, { allow: "POST" });
}
