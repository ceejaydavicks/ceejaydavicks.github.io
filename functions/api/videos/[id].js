/* PUT    /api/videos/:id – replace a video (admin)
   PATCH  /api/videos/:id – partial update, e.g. { featured: true } (admin)
   DELETE /api/videos/:id – delete (admin)                                          */

import { isAdminRequest } from "../../_lib/auth.js";
import { embedThumbnail } from "../../_lib/catalogue.js";
import {
  deleteVideo,
  ensureSchema,
  getVideo,
  getVideoSourceRefs,
  markSourceDeleted,
  updateVideo
} from "../../_lib/db.js";
import { deleteTelegramPost } from "../../_lib/telegram.js";
import { fail, methodNotAllowed } from "../../_lib/http.js";
import { rowToInput, validateVideoInput } from "../../_lib/validate.js";

function parseId(params) {
  const id = Number.parseInt(params.id, 10);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/* The files of a deleted video that live in this site's R2 bucket. Only the
   site's own uploads are stored there — a mirrored bot video keeps its files
   in the bot's own bucket and is left untouched. */
async function removeStoredFiles(env, row) {
  const removed = [];
  if (!env.MEDIA) return removed;

  for (const url of [row.thumbnail_url, row.video_url]) {
    const value = String(url || "");
    if (!value.startsWith("/api/media/")) continue;
    const key = value.slice("/api/media/".length);
    if (!key || key.includes("..") || key.includes("\\")) continue;
    try {
      await env.MEDIA.delete(key);
      removed.push(key);
    } catch (error) {
      /* A file that cannot be removed must not stop the row from going. */
    }
  }

  return removed;
}

export async function onRequestPut({ request, env, params }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  const id = parseId(params);
  if (!id) return fail("Invalid video id");

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return fail("Invalid JSON body");
  }

  await ensureSchema(env);
  const existing = await getVideo(env, id);
  if (!existing) return fail("Video not found", 404);

  const merged = { ...rowToInput(existing), ...body };
  const parsed = validateVideoInput(merged);
  if (parsed.error) return fail(parsed.error, 422);

  /* The panel does not edit the video file, only what is written about it. */
  parsed.values.featured = existing.featured ? 1 : 0;
  parsed.values.pinned = existing.pinned ? 1 : 0;

  /* A thumbnail the admin uploaded always wins over an automatic one. When
     the picture did not change, its origin is kept as it was. */
  const thumbChanged = String(merged.thumbnail_url || "") !== String(existing.thumbnail_url || "");
  if (thumbChanged) {
    parsed.values.thumb_source = body.thumb_source === "auto" ? "auto" : "manual";
  } else {
    parsed.values.thumb_source = existing.thumb_source || parsed.values.thumb_source || "";
  }

  /* An embed without a picture of its own gets the dark placeholder. */
  if (!parsed.values.thumbnail_url && parsed.values.embed_url) {
    parsed.values.thumbnail_url = await embedThumbnail(parsed.values.embed_url);
    parsed.values.thumb_source = "embed";
  }

  const video = await updateVideo(env, id, parsed.values);
  return Response.json({ video }, { headers: { "cache-control": "no-store" } });
}

export async function onRequestPatch({ request, env, params }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  const id = parseId(params);
  if (!id) return fail("Invalid video id");

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return fail("Invalid JSON body");
  }

  await ensureSchema(env);
  const existing = await getVideo(env, id);
  if (!existing) return fail("Video not found", 404);

  const merged = { ...rowToInput(existing), ...body };
  const parsed = validateVideoInput(merged);
  if (parsed.error) return fail(parsed.error, 422);

  /* "Set as featured" makes this the one pinned video and puts it at the top
     of the library; unpinning gives the top spot back to the list. */
  if ("featured" in body) {
    parsed.values.featured = body.featured ? 1 : 0;
    parsed.values.pinned = body.featured ? 1 : 0;
  } else {
    parsed.values.featured = existing.featured ? 1 : 0;
    parsed.values.pinned = existing.pinned ? 1 : 0;
  }

  const thumbChanged = String(merged.thumbnail_url || "") !== String(existing.thumbnail_url || "");
  if (thumbChanged) {
    parsed.values.thumb_source = body.thumb_source === "auto" ? "auto" : "manual";
  } else if (!("thumb_source" in body)) {
    parsed.values.thumb_source = existing.thumb_source || "";
  }

  const video = await updateVideo(env, id, parsed.values);
  return Response.json({ video }, { headers: { "cache-control": "no-store" } });
}

export async function onRequestDelete({ request, env, params }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  const id = parseId(params);
  if (!id) return fail("Invalid video id");

  await ensureSchema(env);
  const existing = await getVideo(env, id);
  if (!existing) return fail("Video not found", 404);

  // A video published from the Telegram channel also leaves its channel post
  // behind otherwise: deleting in the panel means deleting everywhere.
  const refs = await getVideoSourceRefs(env, id);
  const removedFiles = await removeStoredFiles(env, existing);
  await deleteVideo(env, id);
  const channelPostRemoved = await deleteTelegramPost(env, refs);

  /* A mirrored row must not come back with the next catalogue sync. */
  if (refs && refs.source && refs.source !== "site" && refs.source_id) {
    await markSourceDeleted(env, refs.source, refs.source_id);
  }

  return Response.json(
    { ok: true, id, channelPostRemoved, removedFiles },
    { headers: { "cache-control": "no-store" } }
  );
}

export function onRequestGet() {
  return methodNotAllowed(["PUT", "PATCH", "DELETE"]);
}
