/* ============================================================================
   Input validation and sanitisation for video records.
   Text is stored with angle brackets and control characters stripped; the site
   also escapes at render time (defence in depth). URLs must be http(s) — or an
   /api/media/… path for files uploaded to R2.
   ========================================================================== */

import { boolInt, cleanText, safeAssetUrl, safeHttpUrl } from "./http.js";

/* ---- duration -----------------------------------------------------------
   A video's length is stored twice:

   - `duration_seconds` — the real length, an integer. This is the source of
     truth and the only thing the Shorts rule reads (under 60 seconds).
   - `duration` — the "m:ss" label the cards show.

   Every entry point funnels through here, so /admin (which accepts "12:48"),
   the scraper (which reports seconds), the Telegram bot (which reports the
   file's own duration) and direct API calls all end up in the same shape.
   Anything unparseable is kept as free text but leaves the seconds at 0, which
   means "unknown length" — an unknown video is a regular video, never a Short.
   ------------------------------------------------------------------------- */

export function parseDurationSeconds(value) {
  const clamp = (n) => (Number.isFinite(n) && n > 0 ? Math.min(86400, Math.round(n)) : 0);

  if (typeof value === "number") return clamp(value);

  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return 0;

  // Lone digits are seconds — the shape Telegram metadata and the API use.
  if (/^\d+(?:\.\d+)?$/.test(raw)) return clamp(Number(raw));

  // "42s" / "42 sec" / "42 seconds"
  let match = /^(\d+(?:\.\d+)?)\s*s(?:ec(?:s|onds?)?)?$/.exec(raw);
  if (match) return clamp(Number(match[1]));

  // "1h 2m 3s", "2m 5s", "90 min"
  match = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:s|onds?)?)?)?$/.exec(raw);
  if (match && (match[1] || match[2] || match[3])) {
    return clamp(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
  }

  // "0:42", "12:48", "1:02:03"
  const parts = raw.split(":").map((part) => part.trim());
  if (parts.length >= 2 && parts.length <= 3 && parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) {
    return clamp(parts.map(Number).reduce((total, part) => total * 60 + part, 0));
  }

  // ISO 8601, which some scraped pages expose ("PT1M5S").
  match = /^p(?:(\d+)d)?t?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw);
  if (match && (match[1] || match[2] || match[3] || match[4])) {
    return clamp(
      Number(match[1] || 0) * 86400 +
        Number(match[2] || 0) * 3600 +
        Number(match[3] || 0) * 60 +
        Number(match[4] || 0)
    );
  }

  return 0;
}

export function formatDurationSeconds(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!Number.isFinite(total) || total <= 0) return "";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

/* Every tag of a video, as a list. The panel writes them comma separated, the
   Telegram bot sends them as an array — both end up in the same column. */
export function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value == null ? "" : value).split(",");
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const tag = cleanText(entry, 32);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function rowToInput(row) {
  return {
    title: row.title,
    creator: row.creator,
    caption: row.caption,
    thumbnail_url: row.thumbnail_url,
    video_url: row.video_url,
    embed_url: row.embed_url,
    duration: row.duration,
    duration_seconds: row.duration_seconds,
    views: row.views,
    tag: row.tag,
    tags: row.tags,
    orientation: row.orientation,
    featured: Boolean(row.featured),
    pinned: Boolean(row.pinned),
    thumb_source: row.thumb_source
  };
}

export function validateVideoInput(body = {}, { requireSource = false } = {}) {
  const title = cleanText(body.title, 200);
  if (!title) return { error: "A title is required." };

  const rawThumb = typeof body.thumbnail_url === "string" ? body.thumbnail_url.trim() : "";
  const thumbnail = safeAssetUrl(rawThumb);
  if (rawThumb && !thumbnail) {
    return { error: "Thumbnail must be an http(s) image link or an uploaded file." };
  }

  const rawVideo = typeof body.video_url === "string" ? body.video_url.trim() : "";
  const video = safeAssetUrl(rawVideo);
  if (rawVideo && !video) {
    return { error: "Video URL must be a valid http(s) link or an uploaded file." };
  }

  const rawEmbed = typeof body.embed_url === "string" ? body.embed_url.trim() : "";
  const embed = safeHttpUrl(rawEmbed);
  if (rawEmbed && !embed) {
    return { error: "Embed link must be a valid http(s) link." };
  }

  if (video && embed) {
    return { error: "Use either a video URL or an embed link, not both." };
  }

  if (requireSource && !video && !embed) {
    return { error: "Add a video URL (or an embed link) so the video can play." };
  }

  /* An embed usually cannot report its own length, so whatever was typed wins;
     explicit seconds (from the bot or the API) beat the text field. */
  const durationSeconds =
    parseDurationSeconds(body.duration_seconds) || parseDurationSeconds(body.duration);
  const durationLabel = durationSeconds
    ? formatDurationSeconds(durationSeconds)
    : cleanText(body.duration, 16);

  const tags = cleanTags(body.tags);
  const tag = cleanText(body.tag, 32) || tags[0] || "";

  /* How the thumbnail was made. "manual" (uploaded in the panel) always wins
     over anything automatic, so it is kept as it is. */
  const thumbSource = ["manual", "auto", "telegram", "embed"].includes(body.thumb_source)
    ? body.thumb_source
    : "";

  return {
    values: {
      title,
      creator: cleanText(body.creator, 80),
      caption: cleanText(body.caption, 600),
      thumbnail_url: thumbnail,
      video_url: video,
      embed_url: embed,
      duration: durationLabel,
      duration_seconds: durationSeconds,
      views: cleanText(body.views, 32),
      tag,
      tags: tags.join(", "),
      orientation: body.orientation === "vertical" ? "vertical" : "horizontal",
      featured: boolInt(body.featured),
      pinned: boolInt(body.pinned),
      thumb_source: thumbSource
    }
  };
}
