/* GET /api/media/<folder>/<file> — streams an object from the R2 binding MEDIA.
   Thumbnails, admin video uploads and Telegram uploads are served from here, so
   no public bucket access is required.

   Range requests are supported (206 Partial Content), because every mobile
   Safari — and every `<video>` element that wants to seek — asks for byte
   ranges. Without it a video plays from the start and then stalls the moment
   the viewer drags the scrubber.

   Routing note: Cloudflare Pages Functions only supports single-segment route
   parameters such as `[folder]` / `[file]`. The Next.js-style rest parameter
   (`[...key]`) is rejected by Wrangler while generating the Functions bundle
   ("Parameter names must only contain alphanumeric and underscore characters"),
   so the R2 key is reassembled from its two path segments instead. Every key
   this app writes is `thumbs/<name>`, `videos/<name>` or `share/<name>`, so
   the public URLs stay `/api/media/thumbs/<name>` and friends.

   `share/<name>` is the crawler-facing 1200x630 JPG link preview. Everything
   in this route is public and CORS-open: no auth cookie, no age gate, and no
   Content-Disposition: attachment header.                                  */

import { fail } from "../../../_lib/http.js";
import { loadLocalImage } from "../../../_lib/media-store.js";

/* `share/` holds the 1200x630 JPG previews used by og:image / twitter:image.
   Like thumbs and videos it is public: social crawlers must never need a
   cookie, a login session or the age gate to fetch a preview. */
const FOLDERS = new Set(["thumbs", "videos", "share"]);
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/* A few older R2 objects were written before httpMetadata was always set. */
function contentTypeFor(key, metadataType) {
  const type = String(metadataType || "").split(";")[0].trim().toLowerCase();
  if (type) return type;
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

/* Pages hands route parameters back as text; decode defensively so keys with
   escaped characters still resolve, without ever throwing on malformed input. */
function decodeSegment(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

/* Returns { offset, length } for a satisfiable range, null when the client
   asked for the whole object, or "invalid" when the range is unsatisfiable. */
export function parseRange(header, size) {
  const value = String(header || "").trim();
  if (!value) return null;
  if (!Number.isFinite(size) || size <= 0) return "invalid";

  const match = RANGE_RE.exec(value);
  if (!match) return "invalid"; // multi-range or a unit we do not serve

  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";

  if (!hasStart && !hasEnd) return "invalid";

  if (!hasStart) {
    // "bytes=-500" — the last 500 bytes.
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = Number(match[1]);
  if (!Number.isFinite(start) || start >= size) return "invalid";

  const end = hasEnd ? Number(match[2]) : size - 1;
  if (!Number.isFinite(end) || end < start) return "invalid";

  const last = Math.min(end, size - 1);
  return { offset: start, length: last - start + 1 };
}

/* Every object here is public to crawlers: correct type, CORS-open, immutable
   (keys are content-hashed or write-once), and never an attachment download. */
function publicHeaders(contentType, size, etag) {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  headers.set("accept-ranges", "bytes");
  headers.set("access-control-allow-origin", "*");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("timing-allow-origin", "*");
  headers.delete("content-disposition");
  if (etag) headers.set("etag", etag);
  if (Number.isFinite(size)) headers.set("content-length", String(size));
  return headers;
}

export async function onRequestGet({ request, params, env }) {
  const folder = decodeSegment(params && params.folder);
  const file = decodeSegment(params && params.file);
  const key = folder && file ? `${folder}/${file}` : "";

  // Traversal is refused for every path, including the D1-backed one.
  if (!key || key.includes("..") || key.includes("\\")) return fail("Not found", 404);

  /* Small images captured in the admin when the optional R2 binding is absent
     live in D1. They are still served from this same public /api/media/ URL. */
  if (folder === "local") {
    const id = String(file || "").replace(/\.[a-z0-9]{2,5}$/i, "");
    const image = /^[0-9a-f]{8,40}$/i.test(id) ? await loadLocalImage(env, id) : null;
    if (!image) return fail("Not found", 404);
    return new Response(image.bytes, {
      status: 200,
      headers: publicHeaders(image.contentType, image.size, `"local-${id}"`)
    });
  }

  if (!env.MEDIA) return fail("R2 bucket is not configured (binding MEDIA).", 503);
  if (!FOLDERS.has(folder)) return fail("Not found", 404);

  /* Cards ask for a small WebP poster (?w=480). If a 480px variant was
     generated for this object, serve it instead of the full-size original;
     otherwise fall back to the original so a card is never broken. */
  const wantsCard = folder === "thumbs" &&
    new URL(request.url).searchParams.get("w") === "480";
  let objectKey = key;
  let meta = await env.MEDIA.head(key);
  if (wantsCard && meta) {
    try {
      const variantKey = key.replace(/\.[^.]+$/, "") + "-480.webp";
      const variantMeta = await env.MEDIA.head(variantKey);
      if (variantMeta) {
        objectKey = variantKey;
        meta = variantMeta;
      }
    } catch (error) {
      /* No generated variant — the original is still a perfectly good card. */
    }
  }
  if (!meta) return fail("Not found", 404);

  const size = Number(meta.size) || 0;
  const range = parseRange(request.headers.get("range"), size);
  const headers = publicHeaders(
    contentTypeFor(objectKey, meta.httpMetadata?.contentType),
    size,
    meta.httpEtag
  );

  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const object = range
    ? await env.MEDIA.get(objectKey, { range: { offset: range.offset, length: range.length } })
    : await env.MEDIA.get(objectKey);

  if (!object) return fail("Not found", 404);

  if (range) {
    const last = range.offset + range.length - 1;
    headers.set("content-range", `bytes ${range.offset}-${last}/${size}`);
    headers.set("content-length", String(range.length));
  }

  return new Response(object.body, { status: range ? 206 : 200, headers });
}
