/* ============================================================================
   Where admin-uploaded small images live.

   Preferred: R2 (`MEDIA`) at /api/media/thumbs/…, immutable and CORS-open.
   Fallback: a few KB in D1 (`stored_media`) at /api/media/local/<id>, so the
   "Fix missing thumbnails" tool still works on deployments without an R2
   binding. Large video files are never put in D1 — they still require R2.
   ========================================================================== */

import { ensureSchema, getStoredMedia, putStoredMedia } from "./db.js";

export const MAX_D1_IMAGE_BYTES = 1024 * 1024; // 1 MB is plenty for a 480px poster

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(String(text || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hashOf(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20);
}

/* Stores an image and returns the public URL the admin saves on the video.
   `input` may be a Uint8Array or a ReadableStream — R2 accepts both, so we
   only buffer when the D1 fallback is actually needed. */
export async function storeImage(env, key, input, contentType) {
  if (env.MEDIA) {
    await env.MEDIA.put(key, input, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
    return { storage: "r2", url: `/api/media/${key}`, key };
  }

  const value = input instanceof Uint8Array
    ? input
    : new Uint8Array(await new Response(input).arrayBuffer());

  if (value.length > MAX_D1_IMAGE_BYTES) {
    throw new Error(
      "This image is too large to store without the R2 MEDIA binding. Add the binding in Cloudflare, or use a smaller picture."
    );
  }

  await ensureSchema(env);
  const id = await hashOf(value);
  await putStoredMedia(env, id, contentType, bytesToBase64(value), value.length);
  return { storage: "d1", url: `/api/media/local/${id}`, key: `local/${id}` };
}

/* Reads a D1-stored image. Returns null (never throws) when there is no row. */
export async function loadLocalImage(env, id) {
  try {
    const row = await getStoredMedia(env, id);
    if (!row) return null;
    const bytes = base64ToBytes(row.data);
    return {
      bytes,
      contentType: String(row.content_type || "application/octet-stream"),
      size: Number(row.bytes) || bytes.length
    };
  } catch (error) {
    return null;
  }
}
