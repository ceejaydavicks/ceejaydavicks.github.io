/* GET /api/media/<key> – streams an object from the R2 binding MEDIA.
   Thumbnails and Telegram uploads are served from here, so no public bucket
   access is required.                                                       */

import { fail } from "../../_lib/http.js";

export async function onRequestGet({ params, env }) {
  if (!env.MEDIA) return fail("R2 bucket is not configured (binding MEDIA).", 503);

  const key = Array.isArray(params.key) ? params.key.join("/") : params.key;
  if (!key || key.includes("..")) return fail("Not found", 404);

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
