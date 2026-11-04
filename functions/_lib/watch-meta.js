/* ============================================================================
   Per-video link previews for WhatsApp, Telegram, X, Facebook and Discord.
   ----------------------------------------------------------------------------
   Social crawlers do not run JavaScript, so the watch page's runtime meta
   updates are invisible to them. This module builds the tags from the id in
   the query string and injects them into the static HTML at the edge.

   The preview image is the video's own 1200x630 share image (stored in R2 at
   /api/media/share/...), falling back to its thumbnail and then to the logo.
   Every og:image / twitter:image is a full absolute URL — never a relative
   path — so crawlers can fetch it without cookies, login or the age gate.
   ========================================================================== */

import { DEFAULT_BOT_FEED_URL, botFeedUrl } from "./catalogue.js";

export const WATCH_LOGO_IMAGE = "/assets/apple-touch-icon.png";
export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 630;

/* The watch HTML is rewritten per video by a Pages Function, and per deploy by
   the root middleware (versioned asset URLs). It must never sit in a browser
   or CDN cache for minutes: `no-cache` forces a revalidation on every visit,
   which keeps both the preview tags and the asset URLs current. */
export const WATCH_CACHE = "no-cache";

const PLACEHOLDER_THUMB = "/assets/embed-placeholder.webp";

export function escapeAttr(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/* Turns a stored image path (or an already-absolute image URL) into a full
   https URL a crawler can open directly. The placeholder logo never counts as
   a real thumbnail. */
export function absoluteImageUrl(value, origin) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  if (raw === PLACEHOLDER_THUMB || raw.endsWith("/embed-placeholder.webp")) return "";
  if (raw.startsWith("/")) return `${origin}${raw}`;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch (error) {
    return "";
  }
}

/* "My own storage" = this Pages site, its R2 media route, or the site's own
   Telegram bot Worker (the same host that publishes the bot catalogue). */
async function ownStorageHosts(env, origin) {
  const hosts = new Set();
  try { hosts.add(new URL(origin).hostname); } catch (error) { /* ignore */ }
  const candidates = [env && env.SITE_URL, env && env.BOT_FEED_URL, DEFAULT_BOT_FEED_URL];
  try {
    const configured = await botFeedUrl(env);
    if (configured) candidates.push(configured);
  } catch (error) { /* a missing DB must not change the tags */ }
  for (const candidate of candidates) {
    try {
      if (candidate) hosts.add(new URL(candidate).hostname);
    } catch (error) { /* not a URL */ }
  }
  return hosts;
}

/* Optional og:video tags. Only a direct .mp4 on our own storage qualifies:
   embeds and third-party hosts are skipped. Platforms that ignore these tags
   simply keep using og:image, so they can never break a preview. */
function ownMp4(row, origin, hosts) {
  if (!row || row.embed_url) return null;
  const raw = String(row.video_url || "").trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = raw.startsWith("/") ? new URL(raw, origin) : new URL(raw);
  } catch (error) {
    return null;
  }
  /* Production is https; a local `wrangler pages dev` origin is http. Either
     is fine here — the host allowlist below is what keeps out third parties. */
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!raw.startsWith("/") && !hosts.has(parsed.hostname)) return null;
  if (!parsed.pathname.toLowerCase().endsWith(".mp4")) return null;

  const vertical = row.orientation === "vertical";
  return {
    url: parsed.href,
    width: vertical ? 1080 : 1920,
    height: vertical ? 1920 : 1080
  };
}

/* Reads only the fields a preview needs. Any D1/config problem falls back to
   generic copy and the logo — a bad database must never break the page. */
export async function watchMeta(env, origin, id) {
  const canonical = `${origin}/watch/?v=${encodeURIComponent(id)}`;
  const siteName = "BootyMansion";
  let title = `Watch · ${siteName}`;
  let description = `Watch the latest releases on ${siteName}.`;
  let ogImage = `${origin}${WATCH_LOGO_IMAGE}`;
  let imageWidth = 0;
  let imageHeight = 0;
  let imageType = "";
  let video = null;

  try {
    if (env && env.DB) {
      const row = await env.DB
        .prepare(
          `SELECT title, caption, thumbnail_url, share_image_url, video_url,
                  embed_url, duration, duration_seconds, orientation
           FROM videos WHERE id = ? LIMIT 1`
        )
        .bind(String(id).replace(/[^\w-]/g, "").slice(0, 40))
        .first();

      if (row) {
        if (row.title) {
          const videoTitle = cleanText(row.title, 160);
          title = `${videoTitle} · ${siteName}`;
          description = cleanText(row.caption, 300) || `Watch ${videoTitle} on ${siteName}.`;
        }

        const share = absoluteImageUrl(row.share_image_url, origin);
        const thumb = absoluteImageUrl(row.thumbnail_url, origin);
        if (share) {
          ogImage = share;
          imageWidth = SHARE_IMAGE_WIDTH;
          imageHeight = SHARE_IMAGE_HEIGHT;
          imageType = "image/jpeg";
        } else if (thumb) {
          ogImage = thumb;
        }

        video = ownMp4(row, origin, await ownStorageHosts(env, origin));
      }
    }
  } catch (error) {
    /* No binding yet, or the database is unavailable: generic preview. */
  }

  return { title, description, canonical, ogImage, imageWidth, imageHeight, imageType, video };
}

/* Idempotent: all managed tags are removed and rebuilt in one block. The
   existing og:type=video.other and adult-rating tags are never touched.
   og:image is deliberately emitted WITHOUT id="og-image": the page's runtime
   JS used to overwrite it with the logo, which would hide the real preview. */
export function injectWatchMeta(html, meta) {
  const {
    title, description, canonical, ogImage,
    imageWidth, imageHeight, imageType, video
  } = meta || {};
  const e = escapeAttr;
  const cut = html.indexOf("</head>");
  let head = cut >= 0 ? html.slice(0, cut) : html;
  const rest = cut >= 0 ? html.slice(cut) : "";

  head = head
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+name="(?:description|twitter:(?:card|title|description|image))"[^>]*>\s*/gi, "")
    .replace(
      /<meta\s+property="og:(?:title|description|image|image:width|image:height|image:type|url|video|video:secure_url|video:type|video:width|video:height)"[^>]*>\s*/gi,
      ""
    )
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "");

  const tags = [
    `<title>${e(title)}</title>`,
    `<meta name="description" id="meta-description" content="${e(description)}">`,
    `<meta property="og:title" id="og-title" content="${e(title)}">`,
    `<meta property="og:description" id="og-description" content="${e(description)}">`,
    `<meta property="og:image" content="${e(ogImage)}">`,
    `<meta property="og:url" content="${e(canonical)}">`
  ];

  if (imageWidth && imageHeight) {
    tags.push(`<meta property="og:image:width" content="${imageWidth}">`);
    tags.push(`<meta property="og:image:height" content="${imageHeight}">`);
  }
  if (imageType) tags.push(`<meta property="og:image:type" content="${e(imageType)}">`);

  tags.push(
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(title)}">`,
    `<meta name="twitter:description" content="${e(description)}">`,
    `<meta name="twitter:image" content="${e(ogImage)}">`
  );

  if (video && video.url) {
    tags.push(
      `<meta property="og:video" content="${e(video.url)}">`,
      `<meta property="og:video:secure_url" content="${e(video.url)}">`,
      `<meta property="og:video:type" content="video/mp4">`,
      `<meta property="og:video:width" content="${video.width}">`,
      `<meta property="og:video:height" content="${video.height}">`
    );
  }

  tags.push(`<link rel="canonical" id="canonical" href="${e(canonical)}">`);

  head = head.replace(/\s+$/, "");
  return `${head}\n  ${tags.join("\n  ")}\n${rest}`;
}

/* Builds the final response. Content-Length / ETag / Content-Encoding are
   dropped because the body changed; Content-Disposition is removed so the
   watch URL can never be interpreted as a download. */
export function watchHtmlResponse(body, original) {
  const headers = new Headers(original ? original.headers : {});
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", WATCH_CACHE);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.delete("content-disposition");
  return new Response(body, {
    status: original ? original.status : 200,
    statusText: original ? original.statusText : "OK",
    headers
  });
}
