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
  getVideoSourceRefs
} from "./db.js";
import { cleanText, fail, json } from "./http.js";
import { validateVideoInput } from "./validate.js";

const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024; // getFile cap for bots
const MAX_MESSAGE = 4000;
const TELEGRAM_API = "https://api.telegram.org";

const HELP = [
  "Videos:",
  "- Post a video in your channel → it appears on the site (any size)",
  "- Or send a video here → the bot copies it to the channel (any size)",
  "- Or send a link / photo with the caption: Title | Creator | Tag",
  "",
  "Commands:",
  "/list — newest videos",
  "/delete <id> — remove a video (and its channel post)",
  "/feature <id> — make a video the featured one",
  "/id — show your ids and the configured channel"
].join("\n");

/* ---- configuration ------------------------------------------------------ */

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

function secretMatches(request, env, params) {
  const expected = (env.TELEGRAM_WEBHOOK_SECRET || "").trim();
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

function allowedIds(env) {
  return String(env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/* ---- parsing helpers ---------------------------------------------------- */

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

function fileTitle(media) {
  const name = String((media && media.file_name) || "").replace(/\.[^.]+$/, "");
  return cleanText(name, 200) || `Telegram upload ${new Date().toISOString().slice(0, 10)}`;
}

/* ---- telegram api ------------------------------------------------------- */

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

/* Removes the channel message a row was published from. Best effort: the site
   row is already gone, and a missing/blocked bot must not turn a delete into an
   error. */
export async function deleteTelegramPost(env, refs) {
  if (!refs || !refs.tg_message_id || !env.TELEGRAM_BOT_TOKEN) return false;
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

  const values = { ...parsed.values };
  if (fields.tg_chat !== undefined) values.tg_chat = fields.tg_chat;
  if (fields.tg_message_id !== undefined) values.tg_message_id = fields.tg_message_id;

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
    orientation: vertical ? "vertical" : "horizontal",
    featured: false,
    pinned: false,
    tg_chat: tgChat || undefined,
    tg_message_id: tgMessageId || undefined
  });

  const lines = [`Published ✅ ${video.title} (#${video.id})`];
  if (note) lines.push(note);
  if (!thumbnailUrl && !env.MEDIA) {
    lines.push("No thumbnail: add the MEDIA (R2) binding to store Telegram's poster frames.");
  }
  return lines.join("\n");
}

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

async function handleCommand(env, message, chatId, text) {
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, "");
  const id = Number.parseInt(args[0], 10);

  if (command === "/start" || command === "/help") {
    await reply(env, chatId, HELP);
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
  if (!(env.TELEGRAM_WEBHOOK_SECRET || "").trim()) {
    return fail("Telegram webhook is not configured: set TELEGRAM_WEBHOOK_SECRET.", 503);
  }
  if (!secretMatches(request, env, params)) return fail("Unauthorized", 401);
  if (!env.TELEGRAM_BOT_TOKEN) {
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
    if (!media) return json({ ok: true });

    await ensureSchema(env);
    try {
      await publishVideo(env, {
        chat: channelPost.chat,
        message: channelPost,
        text: String(channelPost.caption || "").trim(),
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
