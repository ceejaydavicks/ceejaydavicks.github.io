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
      Boolean(env.ADMIN_TELEGRAM_IDS)
  };

  const report = {
    ok: false,
    checks,
    database: { reachable: false, schemaReady: false, videoCount: null },
    error: null,
    hint: null
  };

  if (!checks.adminPassword) {
    report.error = "ADMIN_PASSWORD is not set on this deployment.";
    report.hint =
      "Pages project → Settings → Variables and Secrets → add ADMIN_PASSWORD as a Secret, then retry the deployment.";
    return json(report, 503);
  }

  if (!checks.dbBinding) {
    report.error = "Missing D1 binding named DB.";
    report.hint = DB_HINT;
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
