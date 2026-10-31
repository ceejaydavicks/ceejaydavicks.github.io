/* POST /api/upload – admin thumbnail upload (multipart/form-data, field "file")
   Stores the image in the R2 binding MEDIA and returns its public URL.        */

import { isAdminRequest } from "../_lib/auth.js";
import { fail, json } from "../_lib/http.js";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);
  if (!env.MEDIA) return fail("R2 bucket is not configured (binding MEDIA).", 503);

  let form;
  try {
    form = await request.formData();
  } catch (error) {
    return fail("Expected multipart/form-data");
  }

  const file = form.get("file");
  if (!file || typeof file === "string") return fail("No file uploaded", 422);

  if (!TYPES[file.type]) return fail("Use a JPG, PNG, WebP, GIF or AVIF image.", 415);
  if (file.size > MAX_BYTES) return fail("Image is larger than 5 MB.", 413);
  if (file.size === 0) return fail("The uploaded file is empty.", 422);

  const key = `thumbs/${Date.now()}-${randomKey()}.${TYPES[file.type]}`;

  try {
    await env.MEDIA.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type,
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
  } catch (error) {
    return fail("Upload failed. Check the R2 binding.", 500);
  }

  return json(
    { url: `/api/media/${key}`, key, size: file.size, type: file.type },
    201
  );
}
