/* GET /api/health — public, read-only diagnostics for the admin deployment.
 *
 * Answers "why can't I sign in?" without exposing a single secret: it reports
 * whether each binding/secret is present, the login lockout state, and a LIVE
 * connection test of D1 and R2 (with timings). No values, tokens or passwords.
 *
 *   200 -> everything the admin needs is wired up
 *   503 -> nothing secret is broken, but something is missing (see `error`)
 */

import { LOGIN_LIMITS, rateLimitStatus } from "../_lib/auth.js";
import { ensureSchema } from "../_lib/db.js";
import { json } from "../_lib/http.js";

const DB_HINT =
  "Pages project → Settings → Bindings → add a D1 database with the variable name DB (for Production and Preview), then retry the deployment.";

function message(error) {
  return String(error && error.message ? error.message : error || "Unknown error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/* A live probe, not just `Boolean(env.X)`: a binding can be present but point
   at a deleted database or a dead bucket. */
async function probe(label, work) {
  const started = Date.now();
  try {
    await work();
    return { label, connected: true, ms: Date.now() - started, error: null };
  } catch (error) {
    return { label, connected: false, ms: Date.now() - started, error: message(error) };
  }
}

export async function onRequestGet({ request, env }) {
  const checks = {
    adminPassword: Boolean(env.ADMIN_PASSWORD && String(env.ADMIN_PASSWORD).trim()),
    sessionSecret: Boolean(env.SESSION_SECRET && String(env.SESSION_SECRET).trim()),
    dbBinding: Boolean(env.DB),
    mediaBinding: Boolean(env.MEDIA),
    telegram:
      Boolean(env.TELEGRAM_BOT_TOKEN) &&
      Boolean(env.TELEGRAM_WEBHOOK_SECRET) &&
      Boolean(env.ADMIN_TELEGRAM_IDS),
    telegramChannel: Boolean(env.TELEGRAM_CHANNEL && String(env.TELEGRAM_CHANNEL).trim())
  };

  const branch = env.CF_PAGES_BRANCH ? String(env.CF_PAGES_BRANCH) : null;
  const report = {
    ok: false,
    deployment: {
      environment: branch ? (branch === "main" ? "production" : "preview") : "local",
      branch,
      commit: env.CF_PAGES_COMMIT_SHA ? String(env.CF_PAGES_COMMIT_SHA).slice(0, 7) : null,
      url: env.CF_PAGES_URL ? String(env.CF_PAGES_URL) : null
    },
    checks,
    login: {
      maxAttempts: LOGIN_LIMITS.maxAttempts,
      windowMinutes: Math.round(LOGIN_LIMITS.windowMs / 60000),
      blockMinutes: Math.round(LOGIN_LIMITS.blockMs / 60000),
      sessionHours: Math.round(LOGIN_LIMITS.sessionTtlSeconds / 3600),
      lockout: { ipKnown: false, attempts: 0, locked: false, retryMinutes: 0 }
    },
    connections: {
      d1: { label: "D1", connected: false, ms: null, error: "not tested" },
      r2: { label: "R2", connected: false, ms: null, error: "binding not configured" }
    },
    limits: { imageUploadMb: 5, videoUploadMb: 95, telegramDirectMb: 20 },
    database: { reachable: false, schemaReady: false, videoCount: null },
    notes: [],
    error: null,
    hint: null
  };

  if (!checks.sessionSecret) {
    report.notes.push(
      "SESSION_SECRET is not set — the session cookie is signed with ADMIN_PASSWORD instead. Sign-in works; changing the password signs everyone out."
    );
  }
  if (!checks.mediaBinding) {
    report.notes.push(
      "No MEDIA (R2) binding. Admin uploads now fall back to the D1 media store, so thumbnails still work; large video uploads still need R2."
    );
  }
  if (!checks.telegram) {
    report.notes.push(
      "Telegram bot is not fully configured (needs ADMIN_TELEGRAM_IDS, TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET). The admin panel does not depend on it."
    );
  }
  if (checks.telegram && !checks.telegramChannel) {
    report.notes.push(
      "TELEGRAM_CHANNEL is not set: the bot can only publish videos up to 20 MB (downloaded into R2). Point it at a public @channel and every size works."
    );
  }

  /* Live D1 test — always attempted when a binding exists, even if the schema
     check later fails. */
  if (checks.dbBinding) {
    report.connections.d1 = await probe("D1", async () => {
      await env.DB.prepare("SELECT 1 AS ok").first();
    });
    report.database.reachable = report.connections.d1.connected;
    if (!report.connections.d1.connected) {
      report.notes.push(`D1 live test failed: ${report.connections.d1.error}`);
    }
  }

  /* Live R2 test: a HEAD on a probe key proves the bucket is reachable without
     writing anything or revealing an object. */
  if (checks.mediaBinding) {
    report.connections.r2 = await probe("R2", async () => {
      await env.MEDIA.head("__health_probe__");
    });
    if (!report.connections.r2.connected) {
      report.notes.push(`R2 live test failed: ${report.connections.r2.error}`);
    }
  }

  /* Make sure login_attempts exists before reading the lockout state. */
  if (checks.dbBinding && report.database.reachable) {
    try {
      await ensureSchema(env);
    } catch (error) {
      report.notes.push(`Schema check failed: ${message(error)}`);
    }
  }

  /* Lockout state for this caller. Only counts/booleans — never the IP,
     a password, a token or a secret value. */
  if (checks.dbBinding && report.database.reachable) {
    try {
      const ip =
        request.headers.get("cf-connecting-ip") ||
        (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
        "unknown";
      report.login.lockout = await rateLimitStatus(env, ip);
    } catch (error) {
      report.notes.push(`Login lockout state unavailable: ${message(error)}`);
    }
  }

  if (!checks.adminPassword) {
    report.error = "Server not configured: ADMIN_PASSWORD missing";
    report.hint =
      "Pages project → Settings → Variables and Secrets → add ADMIN_PASSWORD as a Secret, then retry the deployment.";
    return json(report, 503);
  }

  if (!checks.dbBinding) {
    report.error = "Missing D1 binding named DB.";
    report.hint =
      report.deployment.environment === "preview"
        ? "This is a preview deployment: bindings are added per environment. Pages project → Settings → Bindings → Preview tab → add D1 database with the variable name DB, then retry the preview deployment."
        : DB_HINT;
    return json(report, 503);
  }

  try {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM videos").first();
    report.database.schemaReady = true;
    report.database.videoCount = Number((row && (row.total ?? row.n)) || 0);
    report.ok = report.connections.d1.connected;
  } catch (error) {
    report.error = message(error);
    report.hint =
      "The DB binding exists but the database did not answer. Check that the D1 database still exists, that the binding points at it, and that it is bound to this environment (Production vs Preview).";
  }

  return json(report, report.ok ? 200 : 503);
}

export function onRequestPost() {
  return json({ error: "Method not allowed" }, 405);
}
