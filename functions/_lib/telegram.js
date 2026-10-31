/* ============================================================================
   Telegram upload bot.

   POST /api/telegram               (header secret)
   POST /api/telegram/<SECRET>      (same check, secret also in the path)

   Two ways a video reaches the site:

   A. Public channel (any size) — recommended
      Set TELEGRAM_CHANNEL=@yourchannel and make the bot a channel admin.
      • Post the video in the channel: the bot receives the `channel_post` and
        publishes it as an embedded Telegram player. The file never touches the
        Worker, so there is no 20 MB limit.
      • Or send the video to the bot in a DM: it is `copyMessage`d into the
        channel — also a server-side copy, so any size works — and published the
        same way. The embed URL is https://t.me/<channel>/<message>?embed=1.

   B. Direct to R2 (20 MB and under)
      Without a channel the file is downloaded and stored in the R2 binding
      MEDIA (bots cannot download more than 20 MB, so this path is capped).

   Other updates, from the Telegram user IDs in ADMIN_TELEGRAM_IDS:
   - link + caption "Title | Creator | Tag"  -> video entry (embed or direct file)
   - photo + caption                         -> draft entry with that thumbnail
   - /list, /delete <id>, /feature <id>, /id
   ========================================================================== */

import {
  ensureSchema,
  insertVideo,
  listVideos,
  deleteVideo,
  setVideoFlags,
  findVideoByTelegram,
  findVideoBySourceUrl,
  getVideoSourceRefs
} from "./db.js";
import { cleanText, fail, json } from "./http.js";
import { validateVideoInput } from "./validate.js";
import { extractUrls, formatDuration, normaliseUrl, scrapeUrl } from "./scrape.js";

const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024; // getFile cap for bots
const MAX_MESSAGE = 4000;
const DEFAULT_TELEGRAM_API = "https://api.telegram.org";

/* How much of a scraped file may be copied into R2 automatically. Cloudflare
   accepts the upload, but a bigger file is left on the original host and
   played from there instead. */
const DEFAULT_MIRROR_MAX_MB = 90;
const MAX_THUMB_BYTES = 3 * 1024 * 1024;

/* A message can carry up to three links and a page can list many videos; every
   mirrored file is an outbound subrequest, so one webhook call is bounded. */
const MAX_PUBLISH_PER_MESSAGE = 12;

const HELP = [
  "Videos:",
  "- Post a video in your channel → it appears on the site (any size)",
  "- Or send a video here → the bot copies it to the channel (any size)",
  "- Or paste any video page link → the bot scrapes it and publishes it",
  "- A link posted in the channel is scraped the same way",
  "- Optional: keep a caption as Title | Creator | Tag to override the title",
  "",
  "Commands:",
  "/scrape <url> — scrape a page now",
  "/list — newest videos",
  "/delete <id> — remove a video (and its channel post)",
  "/feature <id> — make a video the featured one",
  "/id — show your ids and the configured channel"
].join("\n");

/* ---- configuration (both naming schemes are accepted) ------------------- */

/* The values documented for this repo (TELEGRAM_*) win; the names used by the
   AfterDark worker template (BOT_TOKEN, WEBHOOK_SECRET, ALLOWED_USER_IDS) work
   as fallbacks, so a bot configured for that template keeps working. */
export function botToken(env) {
  return String((env && (env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN)) || "").trim();
}

export function webhookSecret(env) {
  return String((env && (env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET)) || "").trim();
}

/* Overridable only so the test suite can point at a local mock of the Bot API;
   production always talks to Telegram. */
export function telegramApiBase(env) {
  const base = String((env && env.TELEGRAM_API_BASE) || DEFAULT_TELEGRAM_API).trim();
  return base.replace(/\/+$/, "");
}

/* ---- channel configuration ---------------------------------------------- */

/* TELEGRAM_CHANNEL accepts "@name", "name", "https://t.me/name" or "https://t.me/s/name".
   TELEGRAM_CHANNEL_ID (optional) pins the numeric id, e.g. -1001234567890. */
export function channelConfig(env) {
  const raw = String((env && env.TELEGRAM_CHANNEL) || "").trim();
  const pinnedId = String((env && env.TELEGRAM_CHANNEL_ID) || "").trim();
  if (!raw && !pinnedId) return { username: "", chatId: "" };

  const cleaned = raw
    .replace(/^https?:\/\/(?:www\.)?(?:t|telegram)\.me\//i, "")
    .replace(/^s\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "")
    .trim();

  const username = /^[A-Za-z0-9_]{4,}$/.test(cleaned) ? cleaned : "";
  const chatId = pinnedId || (username ? `@${username}` : cleaned);
  return { username, chatId };
}

export function embedUrlFor(username, messageId) {
  if (!username || !messageId) return "";
  return `https://t.me/${username}/${messageId}?embed=1`;
}

function isConfiguredChannel(env, chat) {
  if (!chat) return false;
  const cfg = channelConfig(env);
  const pinnedId = String((env && env.TELEGRAM_CHANNEL_ID) || "").trim();
  const chatId = String(chat.id);

  if (pinnedId && chatId === pinnedId) return true;
  const username = String(chat.username || "").toLowerCase();
  if (cfg.username && username && username === cfg.username.toLowerCase()) return true;
  if (!cfg.username && cfg.chatId && chatId === cfg.chatId) return true;
  return false;
}

export function secretMatches(request, env, params) {
  const expected = webhookSecret(env);
  if (!expected) return false;

  const header = (request.headers.get("x-telegram-bot-api-secret-token") || "").trim();

  // /api/telegram/<SECRET> arrives as the single-segment route param `secret`.
  // `path` (an array) is still accepted so the check works with either shape.
  let segments = [];
  if (Array.isArray(params && params.path)) segments = params.path;
  else if (params && typeof params.secret === "string") segments = [params.secret];
  const pathSecret = segments.filter((segment) => typeof segment === "string").join("/");

  return header === expected || pathSecret === expected;
}

export function allowedIds(env) {
  return String(env.ADMIN_TELEGRAM_IDS || env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/* ---- parsing helpers ---------------------------------------------------- */

function parseCaption(text) {
  const parts = String(text || "").split("|");
  return {
    title: cleanText(parts[0] || "", 200),
    creator: cleanText(parts[1] || "", 80),
    tag: cleanText(parts[2] || "", 32)
  };
}

function fileTitle(media) {
  const name = String((media && media.file_name) || "").replace(/\.[^.]+$/, "");
  return cleanText(name, 200) || `Telegram upload ${new Date().toISOString().slice(0, 10)}`;
}

/* ---- telegram api ------------------------------------------------------- */

export async function telegram(env, method, payload) {
  const token = botToken(env);
  if (!token) throw new Error("Telegram bot is not configured: set TELEGRAM_BOT_TOKEN.");
  const response = await fetch(`${telegramApiBase(env)}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

/* Removes the channel message a row was published from. Best effort: the site
   row is already gone, and a missing/blocked bot must not turn a delete into an
   error. */
export async function deleteTelegramPost(env, refs) {
  if (!refs || !refs.tg_message_id || !botToken(env)) return false;
  try {
    await telegram(env, "deleteMessage", {
      chat_id: refs.tg_chat,
      message_id: refs.tg_message_id
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function reply(env, chatId, text) {
  const message = String(text || "").slice(0, MAX_MESSAGE);
  try {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    });
  } catch (error) {
    /* A failed reply must not fail the webhook. */
  }
}

async function downloadFile(env, fileId) {
  const file = await telegram(env, "getFile", { file_id: fileId });
  if (!file || !file.file_path) throw new Error("Telegram did not return a file path.");

  const response = await fetch(`${telegramApiBase(env)}/file/bot${botToken(env)}/${file.file_path}`);
  if (!response.ok) throw new Error("Could not download the file from Telegram.");

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    path: file.file_path,
    size: Number(file.file_size || 0)
  };
}

function extensionOf(path, fallback) {
  const match = String(path || "").match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : fallback;
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function storeInR2(env, key, bytes, contentType) {
  if (!env.MEDIA) {
    throw new Error(
      "Saving a file needs R2 (binding MEDIA), which is optional. Post the video in your public channel instead, or paste a link."
    );
  }
  await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" }
  });
  return `/api/media/${key}`;
}

async function createEntry(env, fields) {
  const parsed = validateVideoInput(fields);
  if (parsed.error) throw new Error(parsed.error);

  const values = { ...parsed.values };
  if (fields.tg_chat !== undefined) values.tg_chat = fields.tg_chat;
  if (fields.tg_message_id !== undefined) values.tg_message_id = fields.tg_message_id;
  if (fields.source_url !== undefined) values.source_url = fields.source_url;

  try {
    return await insertVideo(env, values);
  } catch (error) {
    if (/UNIQUE constraint/i.test(String(error && error.message))) {
      throw new Error("That message was already published.");
    }
    throw error;
  }
}

/* Telegram's own poster frame is a few KB, so it is always within the bot's
   download limit — even when the video itself is not. */
async function saveThumbnail(env, media) {
  const fileId = media && media.thumbnail && media.thumbnail.file_id;
  if (!fileId || !env.MEDIA) return "";
  try {
    const thumb = await downloadFile(env, fileId);
    const key = `thumbs/tg-${Date.now()}-${randomKey()}.jpg`;
    return await storeInR2(env, key, thumb.bytes, "image/jpeg");
  } catch (error) {
    return "";
  }
}

/* ---- publishing --------------------------------------------------------- */

async function publishVideo(env, { chat, message, text, fromChannel = false }) {
  const media = message.video || message.document;
  const cfg = channelConfig(env);
  const caption = parseCaption(text);
  const title = caption.title || fileTitle(media);
  const size = Number(media.file_size || 0);

  let tgChat = String(chat.id);
  let tgMessageId = Number(message.message_id || 0);
  let embed = "";
  let videoUrl = "";
  let note = "";

  if (fromChannel) {
    if (!cfg.username) {
      throw new Error(
        "TELEGRAM_CHANNEL must be the channel's public @username, not a numeric id, so posts can be embedded."
      );
    }
    embed = embedUrlFor(cfg.username, tgMessageId);
  } else if (cfg.chatId) {
    /* copyMessage moves the file inside Telegram's own servers: no download,
       no 20 MB ceiling, nothing to store. */
    try {
      const copied = await telegram(env, "copyMessage", {
        chat_id: cfg.chatId,
        from_chat_id: chat.id,
        message_id: message.message_id
      });
      if (!copied || !copied.message_id) throw new Error("Telegram did not return the copied message.");
      if (!cfg.username) {
        throw new Error(
          "The video is in the channel, but TELEGRAM_CHANNEL must be the public @username so a player link can be built."
        );
      }
      tgChat = String((copied.chat && copied.chat.id) || cfg.chatId);
      tgMessageId = Number(copied.message_id);
      embed = embedUrlFor(cfg.username, tgMessageId);
      note = "Playing from your Telegram channel.";
    } catch (error) {
      note = `Could not post it to the channel: ${error.message}`;
      if (size > BOT_DOWNLOAD_LIMIT) {
        throw new Error(
          `${note}\nPost the video directly in the channel instead — the bot publishes it from there with no size limit.`
        );
      }
      tgChat = "";
      tgMessageId = 0;
    }
  }

  if (!embed) {
    if (size > BOT_DOWNLOAD_LIMIT) {
      throw new Error(
        "Videos over 20 MB cannot be downloaded by a bot. Set TELEGRAM_CHANNEL=@yourchannel (bot as channel admin) and send the video there, or post it in the channel directly."
      );
    }

    const file = await downloadFile(env, media.file_id);
    if (file.size && file.size > BOT_DOWNLOAD_LIMIT) {
      throw new Error("That file is larger than 20 MB. Send it through the channel instead.");
    }
    const contentType = media.mime_type || "video/mp4";
    const key = `videos/tg-${Date.now()}-${randomKey()}.${extensionOf(file.path, "mp4")}`;
    videoUrl = await storeInR2(env, key, file.bytes, contentType);
  }

  // Telegram retries webhook deliveries; the same message must not publish twice.
  if (tgMessageId) {
    const existing = await findVideoByTelegram(env, tgChat, tgMessageId);
    if (existing) return `Already published ✅ ${existing.title} (#${existing.id})`;
  }

  const thumbnailUrl = await saveThumbnail(env, media);
  const vertical = Number(media.height || 0) > Number(media.width || 0);

  const video = await createEntry(env, {
    title,
    creator: caption.creator,
    tag: caption.tag,
    thumbnail_url: thumbnailUrl,
    video_url: videoUrl,
    embed_url: embed,
    /* Telegram gives the file's own length in seconds — that is what decides
       whether the site files it under Shorts (under 60s) or the main grid. */
    duration_seconds: Number(media.duration) || 0,
    orientation: vertical ? "vertical" : "horizontal",
    featured: false,
    pinned: false,
    tg_chat: tgChat || undefined,
    tg_message_id: tgMessageId || undefined
  });

  const lines = [`Published ✅ ${video.title} (#${video.id})`];
  if (note) lines.push(note);
  if (!thumbnailUrl && !env.MEDIA) {
    lines.push("No thumbnail: R2 (optional) is not bound, so Telegram's poster frame was skipped.");
  }
  return lines.join("\n");
}

/* ---- scraped links ------------------------------------------------------ */

/* Copying a scraped file into R2 is what makes the video "ours": the site then
   serves it from /api/media/… and the source host can neither hotlink-block
   playback nor delete the file. Files larger than the cap are left in place and
   played from the original URL. */

function mirrorMaxBytes(env) {
  const mb = Number(env.SCRAPE_MIRROR_MAX_MB);
  const limit = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MIRROR_MAX_MB;
  return Math.round(limit * 1024 * 1024);
}

/* Copying into R2 is OPT-IN. R2 is a paid product (it needs a billing profile
   even inside its free allowance), so the default is to link the video where it
   already lives and store nothing: no MEDIA binding, no cost, nothing to set up.
   Set SCRAPE_MIRROR=on to copy files and posters into R2 instead. */
function mirrorEnabled(env) {
  if (!env.MEDIA) return false;
  return /^(?:1|on|true|yes)$/i.test(String(env.SCRAPE_MIRROR || "").trim());
}

function mbLabel(bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionFor(url, contentType) {
  const byType = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-m4v": "m4v",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  };
  if (byType[contentType]) return byType[contentType];
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch (error) {
    /* fall through */
  }
  return contentType.startsWith("image/") ? "jpg" : "mp4";
}

/* Fetch a remote file with the source page as Referer (so hotlink protection
   sees a normal browser). Returns the response still unread, so the body can be
   streamed straight into R2 instead of buffered in memory. */
async function fetchRemoteFile(url, { referer, maxBytes }) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "*/*",
        ...(referer ? { referer } : {})
      },
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    return { error: "could not be reached" };
  }

  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => {});
    return { error: `answered HTTP ${response.status}` };
  }

  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const length = Number(response.headers.get("content-length") || 0);

  if (length && length > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => {});
    return { error: `is ${mbLabel(length)}, over the ${mbLabel(maxBytes)} copy limit`, oversized: true, length };
  }

  /* Without a size there is no way to stay under the limit while streaming, so
     the original URL is used instead of risking a huge upload. */
  if (!length) {
    if (response.body) await response.body.cancel().catch(() => {});
    return { error: "did not report its size" };
  }

  return { response, contentType, length };
}

async function storeRemote(env, url, { referer, folder, maxBytes, kind }) {
  const fetched = await fetchRemoteFile(url, { referer, maxBytes });
  if (fetched.error) return fetched;

  const key = `${folder}/${kind}-${Date.now()}-${randomKey()}.${extensionFor(url, fetched.contentType)}`;
  await env.MEDIA.put(key, fetched.response.body, {
    httpMetadata: {
      contentType: fetched.contentType || (kind === "thumb" ? "image/jpeg" : "video/mp4"),
      cacheControl: "public, max-age=31536000, immutable"
    }
  });
  return { url: `/api/media/${key}`, bytes: fetched.length };
}

/* Posters are used exactly as the page declares them unless copying is on. */
async function mirrorThumbnail(env, url, referer) {
  if (!url || !mirrorEnabled(env)) return url || "";
  const stored = await storeRemote(env, url, {
    referer,
    folder: "thumbs",
    maxBytes: MAX_THUMB_BYTES,
    kind: "scrape"
  });
  return stored.url || url;
}

/* -> { url } on success, { error, oversized } when the copy was attempted and
   failed, { skipped: true } when copying is simply off (not an error). */
async function mirrorVideo(env, url, referer) {
  if (!mirrorEnabled(env)) return { skipped: true };
  return storeRemote(env, url, {
    referer,
    folder: "videos",
    maxBytes: mirrorMaxBytes(env),
    kind: "scrape"
  });
}

/* A tag chip only when the page actually declared keywords — the title and the
   host are not categories, and a wrong chip is worse than none. */
function tagFor(item) {
  const candidates = Array.isArray(item.tags) ? item.tags : [];
  return cleanText(candidates.find((tag) => tag && tag.length <= 32) || "", 32);
}

/**
 * Publish one scraped item. Returns { video } | { skipped } | { error }.
 * `skipped` means "nothing to do" (duplicate, or a page with no player);
 * `error` means the write or the copy failed but is worth telling the admin.
 */
async function publishScrapedItem(env, item, { referer }) {
  const title = cleanText(item.title, 200);
  if (!title) return { skipped: "no title found" };

  const playable = item.sourceKind === "file" || item.sourceKind === "embed";
  const allowPage = /^(?:1|on|true|yes)$/i.test(String(env.SCRAPE_ALLOW_PAGE || "").trim());
  if (!playable && !allowPage) {
    return { skipped: "the page has no readable player — send the direct video or embed link" };
  }

  /* Dedupe on the page URL, not the playable URL: a mirrored file gets a new
     R2 key on every mirror, so video_url alone would never match twice. */
  const sourceUrl = normaliseUrl(item.sourceUrl);
  const duplicate = await findVideoBySourceUrl(env, [sourceUrl]);
  if (duplicate) return { skipped: `already on the site as #${duplicate.id}` };

  const notes = [];
  let videoUrl = "";
  let embedUrl = "";

  if (item.sourceKind === "file") {
    /* Linked from the source by default; copied only when SCRAPE_MIRROR=on and
       R2 is bound. A failed copy still publishes the working original URL. */
    const mirrored = await mirrorVideo(env, item.sourceUrl, referer);
    videoUrl = mirrored.url || item.sourceUrl;
    if (mirrored.error) {
      notes.push(
        mirrored.oversized
          ? `linked from the source (${mbLabel(mirrored.length)} is over the copy limit)`
          : `linked from the source (${mirrored.error})`
      );
    }
  } else {
    embedUrl = item.sourceUrl;
  }

  const thumbnail = await mirrorThumbnail(env, item.thumbnail, referer);
  const duration = formatDuration(item.durationSec);

  let video;
  try {
    video = await createEntry(env, {
      title,
      creator: cleanText(item.creator || "", 80),
      tag: tagFor(item),
      thumbnail_url: thumbnail,
      video_url: videoUrl,
      embed_url: embedUrl,
      duration,
      duration_seconds: Number(item.durationSec) || 0,
      orientation: "horizontal",
      featured: false,
      pinned: false,
      source_url: sourceUrl
    });
  } catch (error) {
    return { error: error && error.message ? error.message : "could not save the video" };
  }

  return { video, notes };
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.slice(0, 60);
  } catch (error) {
    return String(url || "").slice(0, 60);
  }
}

/* Message the site owner(s) directly — used when a channel post fails, because
   the channel itself must stay silent. */
async function notifyOwners(env, text) {
  const ids = allowedIds(env);
  if (!ids.length || !botToken(env)) return;
  try {
    await telegram(env, "sendMessage", {
      chat_id: ids[0],
      text: String(text).slice(0, MAX_MESSAGE),
      disable_web_page_preview: true
    });
  } catch (error) {
    /* best effort: a failed alert must never fail the webhook */
  }
}

async function handleLink(env, message, chatId, text, { notify = true } = {}) {
  const urls = extractUrls(text);
  if (!urls.length) {
    if (notify) await reply(env, chatId, "That does not look like a link. Send the page, video or embed link.");
    return { published: 0, skipped: 0, failed: 0 };
  }

  /* An explicit "Title | Creator | Tag" caption still wins for a single link;
     without one the scraped title is used, which is the automatic path. */
  const caption = parseCaption(text.replace(/https?:\/\/\S+/gi, " "));

  if (notify) {
    await reply(env, chatId, `🔎 Scraping ${urls.length === 1 ? "the link" : `${urls.length} links`} — this can take a few seconds…`);
  }

  const lines = [];
  const totals = { published: 0, skipped: 0, failed: 0 };
  let budget = MAX_PUBLISH_PER_MESSAGE;
  let capped = false;

  for (const url of urls) {
    let result;
    try {
      result = await scrapeUrl(url);
    } catch (error) {
      result = { error: (error && error.message) || "the page could not be scraped" };
    }

    if (result.error) {
      totals.failed += 1;
      lines.push(`⚠️ ${shortUrl(url)} — ${result.error}`);

      /* The manual flow still applies: a caption plus a link is a usable row
         even when the page cannot be read (an embed-only host, a login wall). */
      if (caption.title && urls.length === 1) {
        try {
          const isFile = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(new URL(url).pathname);
          const video = await createEntry(env, {
            title: caption.title,
            creator: caption.creator,
            tag: caption.tag,
            thumbnail_url: "",
            video_url: isFile ? url : "",
            embed_url: isFile ? "" : url,
            orientation: "horizontal",
            featured: false,
            pinned: false
          });
          totals.published += 1;
          lines.push(`Published ✅ ${video.title} (#${video.id}) — from your caption`);
        } catch (error) {
          lines.push(`⚠️ ${(error && error.message) || "could not save the video"}`);
        }
      } else if (caption.title) {
        lines.push("Tip: send one link per message to use a Title | Creator | Tag caption.");
      }
      continue;
    }

    const items = Array.isArray(result.items) ? result.items : [];
    if (result.truncated) capped = true;
    if (!items.length) {
      totals.failed += 1;
      lines.push(`⚠️ ${shortUrl(url)} — no video found on that page`);
      continue;
    }

    /* One link, one item, explicit caption: the human title beats the scrape. */
    if (caption.title && urls.length === 1 && items.length === 1) {
      items[0].title = caption.title;
      items[0].creator = caption.creator;
      items[0].tags = [caption.tag || tagFor(items[0])];
    }

    for (const item of items) {
      if (budget <= 0) {
        capped = true;
        break;
      }
      budget -= 1;
      const outcome = await publishScrapedItem(env, item, { referer: result.finalUrl || url });

      if (outcome.video) {
        totals.published += 1;
        const how = outcome.video.embed_url ? "embed" : "file";
        const notes = outcome.notes && outcome.notes.length ? ` — ${outcome.notes.join("; ")}` : "";
        lines.push(`Published ✅ ${outcome.video.title} (#${outcome.video.id}, ${how})${notes}`);
      } else if (outcome.skipped) {
        totals.skipped += 1;
        lines.push(`⏭️ ${item.title} — ${outcome.skipped}`);
      } else {
        totals.failed += 1;
        lines.push(`⚠️ ${item.title} — ${outcome.error || "could not be saved"}`);
      }
    }
  }

  if (capped) {
    lines.push(`…stopped after ${MAX_PUBLISH_PER_MESSAGE} videos — that is the per-message limit.`);
  }

  const summary = lines.length ? lines.join("\n") : "Nothing was published.";

  if (notify) {
    await reply(env, chatId, summary);
  } else if (totals.failed && !totals.published) {
    /* Quiet mode is for channel posts: the channel stays clean, the owner gets
       told why nothing appeared. */
    await notifyOwners(env, `⚠️ A link posted in Telegram was not published:\n${summary}`);
  }

  return totals;
}

async function handlePhoto(env, message, chatId, text) {
  const sizes = Array.isArray(message.photo) ? message.photo : [];
  const largest = sizes[sizes.length - 1];
  if (!largest) throw new Error("No photo found in the message.");

  const { title, creator, tag } = parseCaption(text);
  if (!title) {
    await reply(env, chatId, "Add a caption in the format: Title | Creator | Tag");
    return;
  }

  const file = await downloadFile(env, largest.file_id);
  const key = `thumbs/tg-${Date.now()}-${randomKey()}.${extensionOf(file.path, "jpg")}`;
  const url = await storeInR2(env, key, file.bytes, "image/jpeg");

  const video = await createEntry(env, {
    title,
    creator,
    tag,
    thumbnail_url: url,
    video_url: "",
    embed_url: "",
    orientation: "horizontal",
    featured: false,
    pinned: false
  });

  await reply(
    env,
    chatId,
    `Thumbnail saved ✅ ${video.title} (#${video.id})\nThis is a draft — add a video link in /admin to publish it.`
  );
}

async function handleCommand(env, message, chatId, text) {
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, "");
  const id = Number.parseInt(args[0], 10);

  if (command === "/start" || command === "/help") {
    await reply(env, chatId, HELP);
    return;
  }

  if (command === "/scrape") {
    const url = args.join(" ").trim();
    if (!url) {
      await reply(env, chatId, "Usage: /scrape <page-url>");
      return;
    }
    await handleLink(env, message, chatId, url);
    return;
  }

  if (command === "/id") {
    const cfg = channelConfig(env);
    const lines = [
      `Your user id: ${(message.from && message.from.id) || "—"}`,
      `This chat id: ${chatId}`,
      cfg.username ? `Channel: @${cfg.username}` : "Channel: not set — add TELEGRAM_CHANNEL=@yourchannel",
      `Channel target: ${cfg.chatId || "—"}`,
      cfg.username ? `Embeds will look like: ${embedUrlFor(cfg.username, 123)}` : ""
    ].filter(Boolean);
    await reply(env, chatId, lines.join("\n"));
    return;
  }

  if (command === "/list") {
    const videos = await listVideos(env);
    if (!videos.length) {
      await reply(env, chatId, "No videos yet. Send a link with a caption to add one.");
      return;
    }
    const lines = videos.slice(0, 15).map((video) => {
      const flags = [
        video.featured ? "featured" : "",
        video.pinned ? "pinned" : "",
        video.embed_url ? "embed" : ""
      ]
        .filter(Boolean)
        .join(", ");
      const source = video.video_url || video.embed_url ? "" : " (draft)";
      return `#${video.id} ${video.title}${flags ? ` — ${flags}` : ""}${source}`;
    });
    await reply(env, chatId, lines.join("\n"));
    return;
  }

  if (command === "/delete") {
    if (!Number.isFinite(id) || id <= 0) {
      await reply(env, chatId, "Usage: /delete <id>");
      return;
    }

    const refs = await getVideoSourceRefs(env, id);
    await deleteVideo(env, id);

    let extra = "";
    if (refs && refs.tg_message_id) {
      extra = (await deleteTelegramPost(env, refs))
        ? "\nThe channel post was removed too."
        : "\nThe channel post could not be removed — delete it in Telegram if you want it gone.";
    }

    await reply(env, chatId, `Deleted ✅ #${id}${extra}`);
    return;
  }

  if (command === "/feature") {
    if (!Number.isFinite(id) || id <= 0) {
      await reply(env, chatId, "Usage: /feature <id>");
      return;
    }
    const video = await setVideoFlags(env, id, { featured: 1 });
    if (!video) {
      await reply(env, chatId, `No video with id #${id}.`);
      return;
    }
    await reply(env, chatId, `Featured ✅ ${video.title} (#${video.id})`);
    return;
  }

  await reply(env, chatId, "Unknown command.\n\n" + HELP);
}

/* ---- webhook entry point ------------------------------------------------ */

function videoMedia(message) {
  if (message.video) return message.video;
  const doc = message.document;
  if (doc && String(doc.mime_type || "").startsWith("video/")) return doc;
  return null;
}

export async function handleTelegram({ request, env, params }) {
  if (!webhookSecret(env)) {
    return fail("Telegram webhook is not configured: set TELEGRAM_WEBHOOK_SECRET.", 503);
  }
  if (!secretMatches(request, env, params)) return fail("Unauthorized", 401);
  if (!botToken(env)) {
    return fail("Telegram bot is not configured: set TELEGRAM_BOT_TOKEN.", 503);
  }

  let update;
  try {
    update = await request.json();
  } catch (error) {
    return fail("Invalid JSON body", 400);
  }

  /* ---- channel post: the no-size-limit path ---------------------------- */
  const channelPost = update.channel_post;
  if (channelPost) {
    // Only the configured channel may publish; anything else is ignored.
    if (!isConfiguredChannel(env, channelPost.chat)) return json({ ok: true });

    const media = videoMedia(channelPost);
    const channelText = String(channelPost.caption || channelPost.text || "").trim();

    await ensureSchema(env);

    if (!media) {
      /* A link posted in the channel is a publish job: scrape it silently so
         the channel stays free of bot chatter, and DM the owner only when
         something could not be published. */
      if (extractUrls(channelText).length) {
        try {
          await handleLink(env, channelPost, channelPost.chat.id, channelText, { notify: false });
        } catch (error) {
          await notifyOwners(
            env,
            `⚠️ A link posted in the channel could not be published: ${
              (error && error.message) || "unknown error"
            }`
          );
        }
      }
      return json({ ok: true });
    }

    try {
      await publishVideo(env, {
        chat: channelPost.chat,
        message: channelPost,
        text: channelText,
        fromChannel: true
      });
    } catch (error) {
      await reply(
        env,
        channelPost.chat.id,
        `⚠️ ${error && error.message ? error.message : "Could not publish that post."}`
      );
    }
    return json({ ok: true });
  }

  const message = update.message || update.edited_message;
  if (!message) return json({ ok: true });

  const admins = allowedIds(env);
  if (!admins.length) {
    return fail("No Telegram admins configured: set ADMIN_TELEGRAM_IDS.", 503);
  }

  const fromId = String((message.from && message.from.id) || (message.chat && message.chat.id) || "");
  const chatId = message.chat && message.chat.id;

  if (!admins.includes(fromId)) {
    await reply(env, chatId, "⛔ This bot only accepts uploads from the site admin.");
    return json({ ok: true });
  }

  await ensureSchema(env);

  const text = String(message.text || message.caption || "").trim();
  const media = videoMedia(message);

  try {
    if (text.startsWith("/")) {
      await handleCommand(env, message, chatId, text);
    } else if (media) {
      const result = await publishVideo(env, { chat: message.chat, message, text });
      if (result) await reply(env, chatId, result);
    } else if (Array.isArray(message.photo) && message.photo.length) {
      await handlePhoto(env, message, chatId, text);
    } else if (extractUrls(text).length) {
      await handleLink(env, message, chatId, text);
    } else {
      await reply(env, chatId, HELP);
    }
  } catch (error) {
    await reply(env, chatId, `⚠️ ${error && error.message ? error.message : "Something went wrong."}`);
  }

  return json({ ok: true });
}
