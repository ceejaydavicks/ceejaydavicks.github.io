/* ============================================================================
   THE CATALOGUE — one list of videos for the whole site
   ----------------------------------------------------------------------------
   The site's own videos live in D1. The Telegram bot keeps its catalogue in
   its own Worker (Workers KV), and the public page used to merge both feeds
   in the browser while the admin panel only ever looked at D1 — which is why
   the panel showed "0 of 0" next to a site full of videos.

   The merge now happens here, on the server, and the result is written into
   the same D1 table the admin panel edits. One table, one list: the panel and
   the public page always read the same rows, and an edit in the panel is
   visible on the site immediately.

   The bot is not modified in any way: its public feed is read exactly as it
   is published, and rows that are already known are never overwritten, so an
   edit made in the panel always wins over the mirrored copy.
   ========================================================================== */

import {
  findVideoBySource,
  insertVideo,
  isSourceDeleted,
  readRawSetting,
  writeRawSetting
} from "./db.js";
import { cleanText, safeHttpUrl } from "./http.js";
import { formatDurationSeconds } from "./validate.js";

/* The bot's public feed. It can be changed in the admin panel (Settings) or
   with the BOT_FEED_URL variable; "off" switches the mirror off completely. */
export const DEFAULT_BOT_FEED_URL = "https://bootymansionbot.prosperj392.workers.dev/api/videos";

const SYNC_KEY = "bot_sync_at";
const SYNC_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

/* Shown when an embed link has no thumbnail of its own: a dark card with the
   site logo, never a black box. */
export const EMBED_PLACEHOLDER = "/assets/embed-placeholder.webp";

export async function botFeedUrl(env) {
  const stored = await readRawSetting(env, "bot_feed_url");
  if (stored === "off") return "";
  if (stored) return stored;
  return env.BOT_FEED_URL || DEFAULT_BOT_FEED_URL;
}

/* Mirrors the bot's catalogue into `videos`.
   - new rows are inserted
   - rows that are already known are left alone (the panel's edits win)
   - rows the admin deleted are never brought back
   Returns { added, total, skipped, error }. */
export async function syncBotCatalogue(env, { force = false } = {}) {
  if (!env.DB) return { added: 0, total: 0, skipped: true };

  const url = await botFeedUrl(env);
  if (!url) return { added: 0, total: 0, skipped: true };

  const stamp = Number(await readRawSetting(env, SYNC_KEY)) || 0;
  if (!force && stamp && Date.now() - stamp < SYNC_INTERVAL_MS) {
    return { added: 0, total: 0, skipped: true };
  }

  /* The stamp is written before the fetch, so a burst of page loads cannot
     start the same mirror twice. */
  await writeRawSetting(env, SYNC_KEY, String(Date.now()));

  let payload;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return { added: 0, total: 0, error: `feed answered ${response.status}` };
    payload = await response.json();
  } catch (error) {
    return { added: 0, total: 0, error: String((error && error.message) || error) };
  }

  const rows = Array.isArray(payload && payload.videos) ? payload.videos : [];
  let added = 0;

  for (const row of rows) {
    const sourceId = cleanText(row && row.id, 80);
    if (!sourceId) continue;
    if (await isSourceDeleted(env, "bot", sourceId)) continue;
    if (await findVideoBySource(env, "bot", sourceId)) continue;

    const stream = safeHttpUrl(row.streamUrl);
    if (!stream) continue;

    const tags = Array.isArray(row.tags)
      ? row.tags.map((tag) => cleanText(tag, 32)).filter(Boolean)
      : [];
    const category = cleanText(row.category, 32);
    const seconds = Number(row.durationSec) || 0;
    const width = Number(row.width) || 0;
    const height = Number(row.height) || 0;
    const thumb = safeHttpUrl(row.thumbUrl);

    await insertVideo(env, {
      title: cleanText(row.title, 200) || "Untitled",
      creator: "",
      caption: cleanText(row.description, 600),
      thumbnail_url: thumb,
      video_url: stream,
      embed_url: "",
      duration: formatDurationSeconds(seconds),
      duration_seconds: seconds,
      views: row.views ? String(row.views) : "",
      tag: category || tags[0] || "",
      tags: tags.join(", "),
      orientation: height > width ? "vertical" : "horizontal",
      featured: 0,
      pinned: 0,
      source: "bot",
      source_id: sourceId,
      thumb_source: thumb ? "telegram" : "",
      created_at: botCreatedAt(row.createdAt)
    });

    added += 1;
  }

  return { added, total: rows.length };
}

/* The bot stores its timestamps in milliseconds. */
function botCreatedAt(value) {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0) return undefined;
  return new Date(stamp).toISOString().slice(0, 19).replace("T", " ");
}

/* ---- embed thumbnails ---------------------------------------------------
   YouTube and Vimeo publish a thumbnail of their own; every other embed gets
   the dark placeholder with the logo, so a card is never an empty black box. */

export function youtubeThumbnail(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") id = parsed.pathname.slice(1);
    else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      if (parsed.pathname === "/watch") id = parsed.searchParams.get("v") || "";
      else if (parsed.pathname.startsWith("/embed/")) id = parsed.pathname.slice("/embed/".length);
      else if (parsed.pathname.startsWith("/shorts/")) id = parsed.pathname.slice("/shorts/".length);
    }
    if (!/^[\w-]{6,20}$/.test(id)) return "";
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  } catch (error) {
    return "";
  }
}

export function vimeoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host !== "vimeo.com" && host !== "player.vimeo.com") return "";
    const match = parsed.pathname.match(/\/(?:video\/)?(\d+)/);
    return match ? match[1] : "";
  } catch (error) {
    return "";
  }
}

/* The thumbnail of an embed link, or the placeholder when the provider has
   none. Vimeo is asked through its public oEmbed endpoint; when that is not
   reachable the direct thumbnail pattern is used. */
export async function embedThumbnail(url) {
  const youtube = youtubeThumbnail(url);
  if (youtube) return youtube;

  const id = vimeoId(url);
  if (id) {
    try {
      const response = await fetch(
        `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (response.ok) {
        const payload = await response.json();
        const thumb = safeHttpUrl(payload && payload.thumbnail_url);
        if (thumb) return thumb;
      }
    } catch (error) {
      /* The network is not available — the pattern below is the fallback. */
    }
    return `https://thumbnail.vimeocdn.com/video/${id}_640.jpg`;
  }

  return EMBED_PLACEHOLDER;
}
