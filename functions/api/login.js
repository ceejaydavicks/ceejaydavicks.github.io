/* POST /api/login  { password } -> sets the HttpOnly admin session cookie.
 *
 * Every failure path returns a short JSON error with a stable `code`, so the
 * admin form can show a human message instead of sitting on "Checking…".
 * Nothing in here reveals the password, the secret name's value, or the token.
 */

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

function brief(error) {
  return String(error && error.message ? error.message : error || "Unknown error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) {
    return fail("Server not configured: ADMIN_PASSWORD missing", 503, {
      "x-admin-error": "not-configured"
    });
  }

  try {
    await ensureSchema(env);

    const ip = clientIp(request);
    const limit = await checkRateLimit(env, ip);
    if (!limit.allowed) {
      return fail(
        `Too many attempts, try again in ${limit.retryMinutes} minute${limit.retryMinutes === 1 ? "" : "s"}`,
        429,
        {
          "retry-after": String(limit.retryAfter),
          "x-admin-error": "rate-limited",
          "x-retry-minutes": String(limit.retryMinutes)
        }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return fail("Invalid request. Please try again.", 400);
    }

    const password = typeof body.password === "string" ? body.password.slice(0, 512) : "";
    if (!password) return fail("Enter the admin password", 422);

    if (!(await passwordMatches(password, env.ADMIN_PASSWORD))) {
      await recordLoginFailure(env, ip);
      return fail("Wrong password", 401, { "x-admin-error": "wrong-password" });
    }

    await clearLoginFailures(env, ip);
    const token = await createSessionToken(env);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, token) });
  } catch (error) {
    /* An exception in a D1 query, the token signer or the cookie builder must
       become a readable error, never an empty 500 that leaves the browser
       waiting for a response that never arrives. */
    return fail(`Sign-in failed: ${brief(error)}`, 500, {
      "x-admin-error": "server-error",
      "x-admin-hint": "Open /api/health for live D1 and R2 checks."
    });
  }
}

export function onRequestGet() {
  return fail("Method not allowed", 405, { allow: "POST" });
}
