/* ============================================================================
   Per-video link previews for WhatsApp, Telegram and X.
   ----------------------------------------------------------------------------
   Social crawlers do not run JavaScript, so the watch page's runtime meta
   updates are invisible to them. This module builds the tags from the id in
   the query string and injects them into the static HTML at the edge.
   The logo (not the video thumbnail) is used as the preview image.
   ========================================================================== */

export const WATCH_LOGO_IMAGE = "/assets/apple-touch-icon.png";

/* The watch HTML is rewritten per video by a Pages Function, and per deploy by
   the root middleware (versioned asset URLs). It must never sit in a browser
   or CDN cache for minutes: `no-cache` forces a revalidation on every visit,
   which keeps both the preview tags and the asset URLs current. */
export const WATCH_CACHE = "no-cache";

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

/* Reads just the two fields a preview needs. Any D1/config problem falls
   back to the generic copy — a bad database must never break the page. */
export async function watchMeta(env, origin, id) {
  const canonical = `${origin}/watch/?v=${encodeURIComponent(id)}`;
  const ogImage = `${origin}${WATCH_LOGO_IMAGE}`;
  const siteName = "BootyMansion";
  let title = `Watch · ${siteName}`;
  let description = `Watch the latest releases on ${siteName}.`;

  try {
    if (env && env.DB) {
      const row = await env.DB
        .prepare("SELECT title, caption FROM videos WHERE id = ? LIMIT 1")
        .bind(String(id).replace(/[^\w-]/g, "").slice(0, 40))
        .first();
      if (row && row.title) {
        const videoTitle = cleanText(row.title, 160);
        title = `${videoTitle} · ${siteName}`;
        description = cleanText(row.caption, 300) || `Watch ${videoTitle} on ${siteName}.`;
      }
    }
  } catch (error) {
    /* No binding yet, or the database is unavailable: generic preview. */
  }

  return { title, description, canonical, ogImage };
}

/* Idempotent: replacing the same tags twice produces the same head. Existing
   adult-rating meta tags and every other head element are left untouched. */
export function injectWatchMeta(html, meta) {
  const { title, description, canonical, ogImage } = meta;
  const e = escapeAttr;
  const cut = html.indexOf("</head>");
  let head = cut >= 0 ? html.slice(0, cut) : html;
  const rest = cut >= 0 ? html.slice(cut) : "";

  head = head
    .replace(/<meta\s+property="og:url"[^>]*>\s*/gi, "")
    .replace(/<meta\s+name="twitter:(?:card|title|description|image)"[^>]*>\s*/gi, "")
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${e(title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i,
      `<meta name="description" id="meta-description" content="${e(description)}">`)
    .replace(/<meta\s+property="og:title"[^>]*>/i,
      `<meta property="og:title" id="og-title" content="${e(title)}">`)
    .replace(/<meta\s+property="og:description"[^>]*>/i,
      `<meta property="og:description" id="og-description" content="${e(description)}">`)
    .replace(/<meta\s+property="og:image"[^>]*>/i,
      `<meta property="og:image" id="og-image" content="${e(ogImage)}">`)
    .replace(/<link\s+rel="canonical"[^>]*>/i,
      `<link rel="canonical" id="canonical" href="${e(canonical)}">`);

  head += "\n  " + [
    `<meta property="og:url" content="${e(canonical)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(title)}">`,
    `<meta name="twitter:description" content="${e(description)}">`,
    `<meta name="twitter:image" content="${e(ogImage)}">`
  ].join("\n  ") + "\n";

  return head + rest;
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
