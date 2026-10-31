/* ============================================================================
   Telegram upload bot (phase two).

   POST /api/telegram               (header secret)
   POST /api/telegram/<SECRET>      (same check, secret also in the path)

   Accepts updates only from the Telegram user IDs in ADMIN_TELEGRAM_IDS:
   - link + caption "Title | Creator | Tag"  -> video entry (embed or direct file)
   - photo + caption                         -> draft entry with that thumbnail
   - video/document under 20 MB              -> file saved to R2 and published
   - /list, /delete <id>, /feature <id>
   ========================================================================== */

import { ensureSchema, insertVideo, listVideos, deleteVideo, setVideoFlags } from "./db.js";
import { cleanText, fail, json } from "./http.js";
import { validateVideoInput } from "./validate.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_MESSAGE = 4000;
const TELEGRAM_API = "https://api.telegram.org";

const HELP = [
  "Uploads:",
  "- Send a link with the caption: Title | Creator | Tag",
  "- Send a photo with the caption: Title | Creator | Tag",
  "- Send a video file (max 20 MB) with the same caption",
  "",
  "Commands:",
  "/list — newest videos",
  "/delete <id> — remove a video",
  "/feature <id> — make a video the featured one"
].join("\n");

function secretMatches(request, env, params) {
  const expected = (env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (!expected) return false;

  const header = (request.headers.get("x-telegram-bot-api-secret-token") || "").trim();
  const segments = Array.isArray(params && params.path) ? params.path : [];
  const pathSecret = segments.join("/");

  return header === expected || pathSecret === expected;
}

function allowedIds(env) {
  return String(env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return "";
  const url = match[0].replace(/[.,;:!?)]+$/, "");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch (error) {
    return "";
  }
}

function parseCaption(text) {
  const parts = String(text || "").split("|");
  return {
    title: cleanText(parts[0] || "", 200),
    creator: cleanText(parts[1] || "", 80),
    tag: cleanText(parts[2] || "", 32)
  };
}

async function telegram(env, method, payload) {
  const response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
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

  const response = await fetch(`${TELEGRAM_API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
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
  if (!env.MEDIA) throw new Error("R2 bucket is not configured (binding MEDIA).");
  await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" }
  });
  return `/api/media/${key}`;
}

async function createEntry(env, fields) {
  const parsed = validateVideoInput(fields);
  if (parsed.error) throw new Error(parsed.error);
  return insertVideo(env, parsed.values);
}

/* ------------------------------------------------------------------ */

async function handleLink(env, message, chatId, text) {
  const url = extractUrl(text);
  if (!url) {
    await reply(env, chatId, "That does not look like a link. Send the link with a caption: Title | Creator | Tag");
    return;
  }

  const { title, creator, tag } = parseCaption(text.replace(url, ""));
  if (!title) {
    await reply(env, chatId, "Add a caption in the format: Title | Creator | Tag");
    return;
  }

  const isFile = /\.(mp4|webm|mov|m4v)$/i.test(new URL(url).pathname);
  const video = await createEntry(env, {
    title,
    creator,
    tag,
    thumbnail_url: "",
    video_url: isFile ? url : "",
    embed_url: isFile ? "" : url,
    orientation: "horizontal",
    featured: false,
    pinned: false
  });

  await reply(env, chatId, `Published ✅ ${video.title} (#${video.id})`);
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

async function handleVideo(env, message, chatId, text) {
  const media = message.video || message.document;
  if (!media) throw new Error("No video found in the message.");

  const size = Number(media.file_size || 0);
  if (size > MAX_UPLOAD_BYTES) {
    await reply(env, chatId, "That file is larger than 20 MB. Please send a smaller file or a link instead.");
    return;
  }

  const { title, creator, tag } = parseCaption(text);
  const fallbackTitle = media.file_name ? media.file_name.replace(/\.[^.]+$/, "") : `Telegram upload ${new Date().toISOString().slice(0, 10)}`;
  const finalTitle = title || cleanText(fallbackTitle, 200);

  const file = await downloadFile(env, media.file_id);
  if (file.size && file.size > MAX_UPLOAD_BYTES) {
    await reply(env, chatId, "That file is larger than 20 MB. Please send a smaller file or a link instead.");
    return;
  }

  const contentType = media.mime_type || "video/mp4";
  const key = `videos/tg-${Date.now()}-${randomKey()}.${extensionOf(file.path, "mp4")}`;
  const videoUrl = await storeInR2(env, key, file.bytes, contentType);

  let thumbnailUrl = "";
  const thumbId = media.thumbnail && media.thumbnail.file_id;
  if (thumbId) {
    try {
      const thumb = await downloadFile(env, thumbId);
      const thumbKey = `thumbs/tg-${Date.now()}-${randomKey()}.jpg`;
      thumbnailUrl = await storeInR2(env, thumbKey, thumb.bytes, "image/jpeg");
    } catch (error) {
      thumbnailUrl = "";
    }
  }

  const vertical = Number(media.height || 0) > Number(media.width || 0);
  const video = await createEntry(env, {
    title: finalTitle,
    creator,
    tag,
    thumbnail_url: thumbnailUrl,
    video_url: videoUrl,
    embed_url: "",
    orientation: vertical ? "vertical" : "horizontal",
    featured: false,
    pinned: false
  });

  await reply(env, chatId, `Published ✅ ${video.title} (#${video.id})`);
}

async function handleCommand(env, message, chatId, text) {
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, "");
  const id = Number.parseInt(args[0], 10);

  if (command === "/start" || command === "/help") {
    await reply(env, chatId, HELP);
    return;
  }

  if (command === "/list") {
    const videos = await listVideos(env);
    if (!videos.length) {
      await reply(env, chatId, "No videos yet. Send a link with a caption to add one.");
      return;
    }
    const lines = videos.slice(0, 15).map((video) => {
      const flags = [video.featured ? "featured" : "", video.pinned ? "pinned" : ""].filter(Boolean).join(", ");
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
    await deleteVideo(env, id);
    await reply(env, chatId, `Deleted ✅ #${id}`);
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

export async function handleTelegram({ request, env, params }) {
  if (!(env.TELEGRAM_WEBHOOK_SECRET || "").trim()) {
    return fail("Telegram webhook is not configured: set TELEGRAM_WEBHOOK_SECRET.", 503);
  }
  if (!secretMatches(request, env, params)) return fail("Unauthorized", 401);
  if (!env.TELEGRAM_BOT_TOKEN) {
    return fail("Telegram bot is not configured: set TELEGRAM_BOT_TOKEN.", 503);
  }

  const admins = allowedIds(env);
  if (!admins.length) {
    return fail("No Telegram admins configured: set ADMIN_TELEGRAM_IDS.", 503);
  }

  let update;
  try {
    update = await request.json();
  } catch (error) {
    return fail("Invalid JSON body", 400);
  }

  const message = update.message || update.channel_post || update.edited_message;
  if (!message) return json({ ok: true });

  const fromId = String((message.from && message.from.id) || (message.chat && message.chat.id) || "");
  const chatId = message.chat && message.chat.id;

  if (!admins.includes(fromId)) {
    await reply(env, chatId, "⛔ This bot only accepts uploads from the site admin.");
    return json({ ok: true });
  }

  await ensureSchema(env);

  const text = String(message.text || message.caption || "").trim();

  try {
    if (text.startsWith("/")) {
      await handleCommand(env, message, chatId, text);
    } else if (message.video || (message.document && String(message.document.mime_type || "").startsWith("video/"))) {
      await handleVideo(env, message, chatId, text);
    } else if (Array.isArray(message.photo) && message.photo.length) {
      await handlePhoto(env, message, chatId, text);
    } else if (extractUrl(text)) {
      await handleLink(env, message, chatId, text);
    } else {
      await reply(env, chatId, HELP);
    }
  } catch (error) {
    await reply(env, chatId, `⚠️ ${error && error.message ? error.message : "Something went wrong."}`);
  }

  return json({ ok: true });
}
