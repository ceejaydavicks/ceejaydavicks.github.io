/* POST /api/upload — admin file uploads.

   Two shapes, one endpoint:

   1. multipart/form-data, field "file"          (thumbnails, small files)
        returns { url, key, size, type, kind, storage }

   2. raw body + headers                         (videos up to 95 MB)
        content-type: video/mp4, video/webm, video/quicktime, video/x-m4v
        x-file-size: 12345678  (optional, used when Content-Length is absent)
      The body is streamed straight into R2, so a large video never has to be
      buffered inside the Function.

   Storage:
     R2 (MEDIA binding)  -> /api/media/thumbs/... (preferred)
     D1 fallback         -> /api/media/local/...  for small images only, so the
                            "Fix missing thumbnails" tool still works when the
                            optional R2 binding has not been added yet.
     Videos always require R2; a clear 503 explains what to add in Cloudflare.

   Size ceilings: images 5 MB, videos 95 MB.
*/

import { isAdminRequest } from "../_lib/auth.js";
import { storeImage } from "../_lib/media-store.js";
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

const NO_R2_VIDEO =
  "Video uploads need the R2 binding MEDIA (optional on the free plan). " +
  "Add it under Pages project → Settings → Bindings, or paste a video link instead. " +
  "Captured card thumbnails work without it.";

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

  /* R2 can take the stream directly; the D1 fallback needs the bytes. */
  if (env.MEDIA) {
    try {
      const stored = await storeImage(env, key, body, info.type);
      return json({
        url: stored.url,
        key,
        size,
        type: info.type,
        kind: info.kind,
        storage: stored.storage
      }, 201);
    } catch (error) {
      return fail("Upload failed while writing to R2. Check the MEDIA binding.", 500);
    }
  }

  if (info.kind === "video") return fail(NO_R2_VIDEO, 503);

  try {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (!bytes.length) return fail("The uploaded file is empty.", 422);
    const stored = await storeImage(env, key, bytes, info.type);
    return json({
      url: stored.url,
      key: stored.key,
      size: bytes.length,
      type: info.type,
      kind: info.kind,
      storage: stored.storage
    }, 201);
  } catch (error) {
    return fail(
      String(error && error.message ? error.message : "Upload failed while saving the image."),
      500
    );
  }
}

export async function onRequestPost({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();

  /* ---- 1. raw body: one video file, streamed ---------------------------- */
  if (!contentType.startsWith("multipart/form-data")) {
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
