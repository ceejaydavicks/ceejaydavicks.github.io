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
   this app writes is `thumbs/<name>` or `videos/<name>`, so the public URLs are
   unchanged: `/api/media/thumbs/<name>`.                                    */

import { fail } from "../../../_lib/http.js";

const FOLDERS = new Set(["thumbs", "videos"]);
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

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

export async function onRequestGet({ request, params, env }) {
  if (!env.MEDIA) return fail("R2 bucket is not configured (binding MEDIA).", 503);

  const folder = decodeSegment(params && params.folder);
  const file = decodeSegment(params && params.file);
  const key = folder && file ? `${folder}/${file}` : "";

  // Only the two generated prefixes are servable, and traversal is refused.
  if (!key || key.includes("..") || key.includes("\\")) return fail("Not found", 404);
  if (!FOLDERS.has(folder)) return fail("Not found", 404);

  const meta = await env.MEDIA.head(key);
  if (!meta) return fail("Not found", 404);

  const size = Number(meta.size) || 0;
  const range = parseRange(request.headers.get("range"), size);

  const headers = new Headers();
  headers.set("content-type", meta.httpMetadata?.contentType || "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  headers.set("accept-ranges", "bytes");
  if (meta.httpEtag) headers.set("etag", meta.httpEtag);

  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const object = range
    ? await env.MEDIA.get(key, { range: { offset: range.offset, length: range.length } })
    : await env.MEDIA.get(key);

  if (!object) return fail("Not found", 404);

  if (range) {
    const last = range.offset + range.length - 1;
    headers.set("content-range", `bytes ${range.offset}-${last}/${size}`);
    headers.set("content-length", String(range.length));
  } else {
    headers.set("content-length", String(size));
  }

  return new Response(object.body, { status: range ? 206 : 200, headers });
}
