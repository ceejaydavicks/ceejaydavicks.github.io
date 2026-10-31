/* PUT    /api/videos/:id – replace a video (admin)
   PATCH  /api/videos/:id – partial update, e.g. { featured: true } (admin)
   DELETE /api/videos/:id – delete (admin)                                          */

import { isAdminRequest } from "../../_lib/auth.js";
import { deleteVideo, ensureSchema, getVideo, getVideoSourceRefs, updateVideo } from "../../_lib/db.js";
import { deleteTelegramPost } from "../../_lib/telegram.js";
import { fail, methodNotAllowed } from "../../_lib/http.js";
import { rowToInput, validateVideoInput } from "../../_lib/validate.js";

function parseId(params) {
  const id = Number.parseInt(params.id, 10);
  return Number.isFinite(id) && id > 0 ? id : 0;
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
  await deleteVideo(env, id);
  const channelPostRemoved = await deleteTelegramPost(env, refs);

  return Response.json(
    { ok: true, id, channelPostRemoved },
    { headers: { "cache-control": "no-store" } }
  );
}

export function onRequestGet() {
  return methodNotAllowed(["PUT", "PATCH", "DELETE"]);
}
