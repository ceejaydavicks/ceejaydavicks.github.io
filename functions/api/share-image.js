/* ============================================================================
   Share-image support (admin only).

   GET  /api/share-image?videoId=<id>
        Streams the video's thumbnail through this same origin so the admin's
        canvas can draw it without a cross-origin taint. Local /assets/ and
        /api/media/ paths are redirected (still same origin); external posters
        are fetched server-side, where CORS does not apply.

   POST /api/share-image
        multipart/form-data: { videoId, file } — the 1200x630 JPG made in the
        browser. Stored at a stable, content-hashed R2 key
        (share/<id>-<hash>.jpg) and saved as videos.share_image_url.

        The resulting /api/media/share/... URL is public (no auth, no age gate)
        and is what og:image / twitter:image point at.

   Size ceiling: 300 KB. The JPG is validated (magic bytes + SOF dimensions),
   so a broken or oversized preview can never be published to crawlers.
   ========================================================================== */

import { isAdminRequest } from "../_lib/auth.js";
import { ensureSchema, getVideo, setShareImage } from "../_lib/db.js";
import { fail, json } from "../_lib/http.js";

const MAX_SHARE_BYTES = 300 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const SHARE_WIDTH = 1200;
const SHARE_HEIGHT = 630;
const SOURCE_TIMEOUT_MS = 12000;
const PLACEHOLDER_THUMB = "/assets/embed-placeholder.webp";

function numericId(value) {
  const id = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/* Reads width/height from a baseline or progressive JPEG SOF marker. Also
   validates the JPEG magic bytes, so an HTML error page cannot be stored. */
export function jpegDimensions(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 3 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += length;
  }
  return null;
}

function privateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return true;
  return host === "localhost" || host.endsWith(".localhost") ||
    host === "127.0.0.1" || host === "::1" || host.endsWith(".internal") ||
    host.startsWith("192.168.") || host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

/* ---- GET: same-origin source image for the canvas ------------------------ */
export async function onRequestGet({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  const url = new URL(request.url);
  const id = numericId(url.searchParams.get("videoId"));
  if (!id) return fail("Invalid video id");

  await ensureSchema(env);
  const video = await getVideo(env, id);
  if (!video) return fail("Video not found", 404);

  const raw = String(video.thumbnail_url || "").trim();
  if (!raw || raw === PLACEHOLDER_THUMB || raw.includes("..") || raw.includes("\\")) {
    return fail("This video has no thumbnail to build a share image from.", 404);
  }

  /* A same-origin redirect keeps the final image same-origin (no taint) and
     avoids an unnecessary Function subrequest. */
  if (raw.startsWith("/")) {
    return new Response(null, {
      status: 302,
      headers: {
        location: new URL(raw, url.origin).toString(),
        "cache-control": "no-store"
      }
    });
  }

  let target;
  try { target = new URL(raw); } catch (error) { return fail("Invalid thumbnail URL", 400); }
  if (target.protocol !== "https:" || privateHost(target.hostname)) {
    return fail("Thumbnail host is not allowed.", 400);
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
    });
  } catch (error) {
    return fail("The thumbnail could not be fetched. Try uploading a picture instead.", 502);
  }
  if (!upstream.ok) return fail(`Thumbnail host answered ${upstream.status}.`, 502);

  const type = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return fail("The thumbnail is not an image.", 415);

  const bytes = await upstream.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_SOURCE_BYTES) {
    return fail("The thumbnail is empty or too large.", 413);
  }

  return new Response(bytes, {
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

/* ---- POST: store the generated JPG and remember its URL ----------------- */
export async function onRequestPost({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);
  if (!env.MEDIA) {
    return fail("Share images need the R2 binding MEDIA.", 503);
  }

  let form;
  try { form = await request.formData(); } catch (error) { return fail("Expected multipart/form-data", 400); }

  const id = numericId(form.get("videoId"));
  if (!id) return fail("Invalid video id");

  const file = form.get("file");
  if (!file || typeof file === "string") return fail("No share image uploaded", 422);

  const type = String(file.type || "").split(";")[0].trim().toLowerCase();
  if (type !== "image/jpeg") return fail("The share image must be a JPG.", 415);

  const declared = Number(file.size) || 0;
  if (!declared) return fail("The share image is empty.", 422);
  if (declared > MAX_SHARE_BYTES) {
    return fail(`The share image must be under 300 KB (it is ${(declared / 1024).toFixed(0)} KB).`, 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_SHARE_BYTES) {
    return fail("The share image is empty or over 300 KB.", 413);
  }
  const dimensions = jpegDimensions(bytes);
  if (!dimensions) return fail("That is not a valid JPG image.", 415);
  if (Math.abs(dimensions.width - SHARE_WIDTH) > 2 || Math.abs(dimensions.height - SHARE_HEIGHT) > 2) {
    return fail(`The share image must be ${SHARE_WIDTH}x${SHARE_HEIGHT}.`, 422);
  }

  await ensureSchema(env);
  const existing = await getVideo(env, id);
  if (!existing) return fail("Video not found", 404);

  /* Content hash means the URL changes only when the image changes. That is
     both stable and safe to cache immutably for a year. */
  const key = `share/${id}-${await hashBytes(bytes)}.jpg`;
  const imageUrl = `/api/media/${key}`;

  try {
    await env.MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    return fail("Could not write the share image to R2.", 500);
  }

  /* Remove the previous preview so regenerating does not leave orphans. */
  const previous = String(existing.share_image_url || "");
  if (previous && previous !== imageUrl && previous.startsWith("/api/media/share/")) {
    const oldKey = previous.slice("/api/media/".length);
    if (oldKey && !oldKey.includes("..") && !oldKey.includes("\\")) {
      try { await env.MEDIA.delete(oldKey); } catch (error) { /* best effort */ }
    }
  }

  const video = await setShareImage(env, id, imageUrl);
  return json({
    url: imageUrl,
    key,
    size: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    video
  }, 201);
}
