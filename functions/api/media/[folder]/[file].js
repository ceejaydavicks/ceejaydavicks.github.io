/* GET /api/media/<folder>/<file> — streams an object from the R2 binding MEDIA.
   Thumbnails and Telegram uploads are served from here, so no public bucket
   access is required.

   Routing note: Cloudflare Pages Functions only supports single-segment route
   parameters such as `[folder]` / `[file]`. The Next.js-style rest parameter
   (`[...key]`) is rejected by Wrangler while generating the Functions bundle
   ("Parameter names must only contain alphanumeric and underscore characters"),
   so the R2 key is reassembled from its two path segments instead. Every key
   this app writes is `thumbs/<name>` or `videos/<name>`, so the public URLs are
   unchanged: `/api/media/thumbs/<name>`.                                    */

import { fail } from "../../../_lib/http.js";

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

export async function onRequestGet({ params, env }) {
  if (!env.MEDIA) return fail("R2 bucket is not configured (binding MEDIA).", 503);

  const folder = decodeSegment(params && params.folder);
  const file = decodeSegment(params && params.file);
  const key = folder && file ? `${folder}/${file}` : "";

  // Only the two generated prefixes are servable, and traversal is refused.
  if (!key || key.includes("..") || key.includes("\\")) return fail("Not found", 404);
  if (folder !== "thumbs" && folder !== "videos") return fail("Not found", 404);

  const object = await env.MEDIA.get(key);
  if (!object) return fail("Not found", 404);

  const headers = new Headers();
  headers.set("content-type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  headers.set("etag", object.httpEtag);
  if (typeof object.size === "number") headers.set("content-length", String(object.size));

  return new Response(object.body, { headers });
}
