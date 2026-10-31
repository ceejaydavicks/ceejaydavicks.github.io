/* GET /api/health — public, read-only diagnostics for the admin deployment.
 *
 * Answers "why does /admin say 500?" without exposing a single secret: it only
 * reports whether each binding/secret is present, whether the database answers,
 * and whether the tables could be created. Open it in a phone browser.
 *
 *   200 -> everything the admin needs is wired up
 *   503 -> nothing secret is broken, but something is missing (see `error`)
 */

import { ensureSchema } from "../_lib/db.js";
import { json } from "../_lib/http.js";

const DB_HINT =
  "Pages project → Settings → Bindings → add a D1 database with the variable name DB (for Production and Preview), then retry the deployment.";

function message(error) {
  const text = String(error && error.message ? error.message : error || "Unknown error");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function onRequestGet({ env }) {
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

  // Which deployment answered? Cloudflare sets these on every Pages build, so
  // the report proves whether you are looking at production or a preview, and at
  // which commit — the usual source of "I added the binding but it still fails".
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
    limits: { imageUploadMb: 5, videoUploadMb: 95, telegramDirectMb: 20 },
    database: { reachable: false, schemaReady: false, videoCount: null },
    notes: [],
    error: null,
    hint: null
  };

  // Optional pieces: say what still works without them instead of failing.
  if (!checks.sessionSecret) {
    report.notes.push(
      "SESSION_SECRET is not set — the session cookie is signed with ADMIN_PASSWORD instead. Sign-in works; changing the password signs everyone out."
    );
  }
  if (!checks.mediaBinding) {
    report.notes.push(
      "No MEDIA (R2) binding: thumbnail uploads and Telegram video files are unavailable. External image URLs, video URLs and embed links still work."
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

  if (!checks.adminPassword) {
    report.error = "ADMIN_PASSWORD is not set on this deployment.";
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
    await env.DB.prepare("SELECT 1 AS ok").first();
    report.database.reachable = true;

    // Creates videos/settings/login_attempts if this is the first request.
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM videos").first();
    report.database.schemaReady = true;
    report.database.videoCount = Number((row && (row.total ?? row.n)) || 0);
    report.ok = true;
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
