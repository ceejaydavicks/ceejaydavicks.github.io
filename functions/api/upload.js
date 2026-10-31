/* POST /api/upload — admin file uploads into the R2 binding MEDIA.

   Two shapes, one endpoint:

   1. multipart/form-data, field "file"          (thumbnails, small files)
        returns { url, key, size, type, kind }

   2. raw body + headers                         (videos up to 95 MB)
        content-type: video/mp4, video/webm, video/quicktime, video/x-m4v
        x-file-size: 12345678  (optional, used when Content-Length is absent)
        x-kind: video          (optional; the content type is enough)
      The body is streamed straight into R2, so a large video never has to be
      buffered inside the Function.

   Size ceilings:
     images 5 MB          — grid thumbnails/player posters
     videos 95 MB         — Cloudflare caps a request body at 100 MB on the
                            Free/Pro plans, so 95 MB leaves room for the
                            multipart framing. Anything larger should arrive
                            through the Telegram channel, where the file never
                            passes through the Worker at all.
*/

import { isAdminRequest } from "../_lib/auth.js";
import { fail, json } from "../_lib/http.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_VIDEO_BYTES = 95 * 1024 * 1024; // 95 MB

const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};

const VIDEO_TYPES = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v"
};

const TOO_BIG_VIDEO =
  "That video is larger than 95 MB. Cloudflare rejects request bodies over 100 MB, " +
  "so send bigger videos to your Telegram bot (see TELEGRAM_CHANNEL in SETUP.md) or paste a link instead.";

const TOO_BIG_IMAGE = "That image is larger than 5 MB. Resize it or paste an image link instead.";

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extensionOf(name) {
  const match = String(name || "").match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : "";
}

/* Browsers occasionally report an empty type for a dropped file, so the
   filename is used as a hint before giving up. */
function classify(type, name) {
  const clean = String(type || "").split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES[clean]) return { kind: "thumb", ext: IMAGE_TYPES[clean], type: clean };
  if (VIDEO_TYPES[clean]) return { kind: "video", ext: VIDEO_TYPES[clean], type: clean };

  const ext = extensionOf(name);
  const imageMatch = Object.entries(IMAGE_TYPES).find(([, value]) => value === ext);
  if (imageMatch) return { kind: "thumb", ext, type: imageMatch[0] };
  const videoMatch = Object.entries(VIDEO_TYPES).find(([, value]) => value === ext);
  if (videoMatch) return { kind: "video", ext, type: videoMatch[0] };

  return null;
}

function limitsFor(kind) {
  return kind === "video"
    ? { max: MAX_VIDEO_BYTES, folder: "videos" }
    : { max: MAX_IMAGE_BYTES, folder: "thumbs" };
}

async function store(env, { body, info, size }) {
  const { max, folder } = limitsFor(info.kind);
  if (size > max) return fail(info.kind === "video" ? TOO_BIG_VIDEO : TOO_BIG_IMAGE, 413);
  if (size === 0) return fail("The uploaded file is empty.", 422);

  const key = `${folder}/${Date.now()}-${randomKey()}.${info.ext}`;

  try {
    await env.MEDIA.put(key, body, {
      httpMetadata: {
        contentType: info.type,
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    return fail("Upload failed while writing to R2. Check the MEDIA binding.", 500);
  }

  return json(
    {
      url: `/api/media/${key}`,
      key,
      size,
      type: info.type,
      kind: info.kind
    },
    201
  );
}

export async function onRequestPost({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);
  if (!env.MEDIA) return fail("R2 bucket is not configured (binding MEDIA).", 503);

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();

  /* ---- 1. raw body: one video file, streamed ---------------------------- */
  if (!contentType.startsWith("multipart/form-data")) {
    // Browsers set Content-Length for a File body; the admin panel also sends
    // x-file-size so the size is known even behind a proxy that strips it.
    const declared = Number(
      request.headers.get("content-length") || request.headers.get("x-file-size") || 0
    );
    const info = classify(contentType, request.headers.get("x-filename") || "");
    if (!info) {
      return fail("Upload an image (JPG/PNG/WebP/GIF/AVIF) or a video (MP4/WebM/MOV).", 415);
    }
    if (!request.body) return fail("The upload was empty.", 422);
    if (!declared) return fail("The upload is missing its size (Content-Length header).", 411);

    return store(env, { body: request.body, info, size: declared });
  }

  /* ---- 2. multipart: the thumbnail button, or a video in a form --------- */
  let form;
  try {
    form = await request.formData();
  } catch (error) {
    return fail("Expected multipart/form-data", 400);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") return fail("No file uploaded", 422);

  const info = classify(file.type, file.name);
  if (!info) {
    return fail("Upload a JPG, PNG, WebP, GIF or AVIF image, or an MP4/WebM/MOV video.", 415);
  }

  return store(env, { body: file.stream(), info, size: Number(file.size) || 0 });
}
