/* ============================================================================
   Input validation and sanitisation for video records.
   Text is stored with angle brackets and control characters stripped; the site
   also escapes at render time (defence in depth). URLs must be http(s) — or an
   /api/media/… path for files uploaded to R2.
   ========================================================================== */

import { boolInt, cleanText, safeAssetUrl, safeHttpUrl } from "./http.js";

export function rowToInput(row) {
  return {
    title: row.title,
    creator: row.creator,
    thumbnail_url: row.thumbnail_url,
    video_url: row.video_url,
    embed_url: row.embed_url,
    duration: row.duration,
    views: row.views,
    tag: row.tag,
    orientation: row.orientation,
    featured: Boolean(row.featured),
    pinned: Boolean(row.pinned)
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

  return {
    values: {
      title,
      creator: cleanText(body.creator, 80),
      thumbnail_url: thumbnail,
      video_url: video,
      embed_url: embed,
      duration: cleanText(body.duration, 16),
      views: cleanText(body.views, 32),
      tag: cleanText(body.tag, 32),
      orientation: body.orientation === "vertical" ? "vertical" : "horizontal",
      featured: boolInt(body.featured),
      pinned: boolInt(body.pinned)
    }
  };
}
