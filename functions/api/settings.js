/* GET /api/settings – public site settings (name, Telegram link, ad slots)
   PUT /api/settings – admin update                                          */

import { isAdminRequest } from "../_lib/auth.js";
import { ensureSchema, readSettings, writeSettings } from "../_lib/db.js";
import { cachedResponse, SETTINGS_CACHE } from "../_lib/edge-cache.js";
import { cleanText, fail, safeHttpUrl } from "../_lib/http.js";

const MAX_AD_CODE = 20000;

export async function onRequestGet({ request, env }) {
  /* Settings are read on every public page load. Caching the immutable-ish
     payload at the edge removes a D1 round trip for almost every visitor. */
  return cachedResponse(request, async () => {
    await ensureSchema(env);
    const settings = await readSettings(env);
    return Response.json(
      { settings },
      {
        headers: {
          "cache-control": SETTINGS_CACHE,
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff"
        }
      }
    );
  });
}

function validateSettings(body) {
  const patch = {};

  if ("siteName" in body) {
    const siteName = cleanText(body.siteName, 60);
    if (!siteName) return { error: "Site name cannot be empty." };
    patch.siteName = siteName;
  }

  if ("telegramUrl" in body) {
    const raw = typeof body.telegramUrl === "string" ? body.telegramUrl.trim() : "";
    const url = safeHttpUrl(raw);
    if (raw && !url) return { error: "Telegram link must be a valid http(s) URL." };
    patch.telegramUrl = url;
  }

  if ("adSmartlinkUrl" in body) {
    const raw = typeof body.adSmartlinkUrl === "string" ? body.adSmartlinkUrl.trim() : "";
    const url = safeHttpUrl(raw);
    if (raw && !url) return { error: "Smartlink must be a valid http(s) URL." };
    patch.adSmartlinkUrl = url;
  }

  /* Where the Telegram bot's own catalogue is mirrored from. "off" switches
     the mirror off; an empty value falls back to the built-in default. */
  if ("botFeedUrl" in body) {
    const raw = typeof body.botFeedUrl === "string" ? body.botFeedUrl.trim() : "";
    if (raw.toLowerCase() === "off") {
      patch.botFeedUrl = "off";
    } else {
      const url = safeHttpUrl(raw);
      if (raw && !url) return { error: "The bot feed URL must be a valid http(s) URL (or \"off\")." };
      patch.botFeedUrl = url;
    }
  }

  // Ad snippets are HTML by design (they carry the network's own <script>),
  // so they are length-limited rather than stripped. Only an admin can write them.
  for (const field of ["adBannerCode", "adNativeCode", "adSmartlinkCode"]) {
    if (!(field in body)) continue;
    const value = typeof body[field] === "string" ? body[field] : "";
    if (value.length > MAX_AD_CODE) return { error: "Ad code is too long." };
    patch[field] = value;
  }

  return { patch };
}

export async function onRequestPut({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return fail("Invalid JSON body");
  }

  const { error, patch } = validateSettings(body);
  if (error) return fail(error, 422);

  await ensureSchema(env);
  const settings = await writeSettings(env, patch);
  return Response.json({ settings }, { headers: { "cache-control": "no-store" } });
}
