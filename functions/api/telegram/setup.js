/* ============================================================================
   GET  /api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
   POST /api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>

   One place to answer "why is my bot not posting anything?".

   GET  reports what Telegram itself says about this bot — the token works, the
        webhook URL it currently has, how many updates are queued, and the last
        delivery error — next to what this deployment expects. A mismatch there
        is the usual cause: the webhook still points at a Worker, a preview
        URL, or a different secret.

   POST registers (or re-registers) the webhook for THIS deployment with the
        right secret and `allowed_updates`, which is otherwise a hand-built
        curl command. Body: { "drop_pending_updates": true } to discard the
        backlog Telegram is holding.

   Auth is the webhook secret itself: as `?secret=`, or in the
   X-Telegram-Bot-Api-Secret-Token header. Nothing secret is ever echoed back —
   the webhook URL is redacted before it leaves the Function.
   ========================================================================== */

import { channelConfig, botToken, webhookSecret, allowedIds } from "../../_lib/telegram.js";
import { fail, json } from "../../_lib/http.js";

const ALLOWED_UPDATES = ["message", "channel_post", "edited_message"];

function providedSecret(request, url) {
  return (
    (url.searchParams.get("secret") || "").trim() ||
    (request.headers.get("x-telegram-bot-api-secret-token") || "").trim()
  );
}

function authorised(request, env, url) {
  const expected = webhookSecret(env);
  if (!expected) return false;
  return providedSecret(request, url) === expected;
}

function redact(value, secret) {
  const text = String(value || "");
  if (!secret) return text;
  return text.split(secret).join("…");
}

async function callTelegram(env, method, payload) {
  const token = botToken(env);
  const base = String(env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const response = await fetch(`${base}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  return { ok: Boolean(data.ok), result: data.result, error: data.description || "" };
}

function expectedWebhookUrl(env, request, secret) {
  const origin = String(env.CF_PAGES_URL || new URL(request.url).origin).replace(/\/+$/, "");
  return `${origin}/api/telegram/${secret}`;
}

function configSummary(env, secret) {
  const channel = channelConfig(env);
  return {
    botToken: Boolean(botToken(env)),
    webhookSecret: Boolean(secret),
    channel: channel.username ? `@${channel.username}` : channel.chatId ? "(numeric id — embeds need @username)" : "",
    admins: allowedIds(env),
    r2: Boolean(env.MEDIA),
    r2Copy: /^(?:1|on|true|yes)$/i.test(String(env.SCRAPE_MIRROR || "").trim()),
    db: Boolean(env.DB),
    autoPublish: true,
    mirrorMaxMb: Number(env.SCRAPE_MIRROR_MAX_MB) > 0 ? Number(env.SCRAPE_MIRROR_MAX_MB) : 90,
    pageLinks: /^(?:1|on|true|yes)$/i.test(String(env.SCRAPE_ALLOW_PAGE || "").trim())
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!webhookSecret(env)) {
    return fail(
      "TELEGRAM_WEBHOOK_SECRET is not set on this deployment, so no webhook can be verified.",
      503
    );
  }
  if (!authorised(request, env, url)) return fail("Unauthorized", 401);

  const secret = webhookSecret(env);
  const expected = expectedWebhookUrl(env, request, secret);
  const config = configSummary(env, secret);
  const hints = [];

  if (!config.botToken) {
    return fail(
      "TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is not set on this deployment.",
      503
    );
  }

  const me = await callTelegram(env, "getMe");
  const info = await callTelegram(env, "getWebhookInfo");

  if (!me.ok) {
    hints.push(`Telegram rejected the bot token: ${me.error || "unknown error"}. Re-check the token from @BotFather.`);
  }

  const webhook = info.ok && info.result ? info.result : null;
  const liveUrl = webhook && webhook.url ? redact(webhook.url, secret) : "";

  if (!webhook) {
    hints.push(`getWebhookInfo failed: ${info.error || "unknown error"}.`);
  } else if (!webhook.url) {
    hints.push("No webhook is registered — Telegram delivers nothing. POST to this URL to set it.");
  } else if (!webhook.url.includes(`/api/telegram/${secret}`)) {
    hints.push(
      "The registered webhook does not point at this deployment's /api/telegram/<secret>. " +
        "POST to this URL to re-register it."
    );
  }
  if (webhook && webhook.last_error_message) {
    hints.push(
      `Telegram's last delivery failed: ${webhook.last_error_message}. ` +
        "A 401/503 here means the secret or a binding is wrong on the deployment Telegram called."
    );
  }
  if (webhook && Number(webhook.pending_update_count) > 0) {
    hints.push(
      `${webhook.pending_update_count} update(s) are queued — Telegram is retrying. ` +
        "Once the error above is fixed they are delivered automatically."
    );
  }
  if (webhook && Array.isArray(webhook.allowed_updates) && webhook.allowed_updates.length &&
      !webhook.allowed_updates.includes("channel_post")) {
    hints.push("allowed_updates is missing channel_post, so channel videos are never delivered.");
  }
  if (!config.channel) {
    hints.push(
      "TELEGRAM_CHANNEL is not set. Without a public @channel the bot cannot build an embed link and is limited to 20 MB downloads."
    );
  }
  if (!config.admins.length) {
    hints.push("ADMIN_TELEGRAM_IDS (or ALLOWED_USER_IDS) is empty — every DM is refused. Send /id to the bot to learn your id.");
  }
  /* R2 is optional by design: the bot links videos instead of storing them. It
     only becomes a problem when copying was explicitly switched on. */
  if (config.r2Copy && !config.r2) {
    hints.push(
      "SCRAPE_MIRROR is on but there is no MEDIA (R2) binding on this deployment, so nothing can be copied. " +
        "Remove SCRAPE_MIRROR to link videos instead."
    );
  }

  return json({
    ok: hints.length === 0,
    deployment: {
      environment: env.CF_PAGES_BRANCH
        ? String(env.CF_PAGES_BRANCH) === "main" ? "production" : "preview"
        : "local",
      commit: env.CF_PAGES_COMMIT_SHA ? String(env.CF_PAGES_COMMIT_SHA).slice(0, 7) : null
    },
    bot: me.ok
      ? { username: me.result.username, id: me.result.id, name: me.result.first_name }
      : { error: me.error || "unknown error" },
    webhook: {
      registered: liveUrl || "(none)",
      expected: redact(expected, secret),
      matches: Boolean(webhook && webhook.url === expected),
      pendingUpdates: webhook ? Number(webhook.pending_update_count || 0) : null,
      lastError: webhook ? webhook.last_error_message || null : null,
      allowedUpdates: webhook && webhook.allowed_updates ? webhook.allowed_updates : null
    },
    config,
    hints
  });
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!webhookSecret(env)) {
    return fail("TELEGRAM_WEBHOOK_SECRET is not set on this deployment.", 503);
  }
  if (!authorised(request, env, url)) return fail("Unauthorized", 401);
  if (!botToken(env)) {
    return fail("TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is not set on this deployment.", 503);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (error) {
    body = {};
  }

  const secret = webhookSecret(env);
  const target = expectedWebhookUrl(env, request, secret);

  const set = await callTelegram(env, "setWebhook", {
    url: target,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: Boolean(body && body.drop_pending_updates)
  });

  if (!set.ok) {
    return fail(`Telegram refused the webhook: ${set.error || "unknown error"}`, 502);
  }

  return json({
    ok: true,
    url: redact(target, secret),
    allowedUpdates: ALLOWED_UPDATES,
    note: "Telegram will now deliver messages, channel posts and edited messages to this deployment."
  });
}

export function onRequest() {
  return fail("Method not allowed", 405, { allow: "GET, POST" });
}
