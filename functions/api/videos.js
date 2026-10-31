/* GET  /api/videos        – public list (published videos only)
   GET  /api/videos?all=1  – admin list (includes drafts)
   POST /api/videos        – admin create                                            */

import { isAdminRequest } from "../_lib/auth.js";
import { ensureSchema, insertVideo, listPublishedVideos, listVideos } from "../_lib/db.js";
import { fail, methodNotAllowed } from "../_lib/http.js";
import { validateVideoInput } from "../_lib/validate.js";

export async function onRequestGet({ request, env }) {
  await ensureSchema(env);

  const wantsAll = new URL(request.url).searchParams.get("all") === "1";
  if (wantsAll && !(await isAdminRequest({ request, env }))) {
    return fail("Unauthorized", 401);
  }

  const videos = wantsAll ? await listVideos(env) : await listPublishedVideos(env);
  return new Response(JSON.stringify({ videos }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": wantsAll ? "no-store" : "public, max-age=30, stale-while-revalidate=120",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function onRequestPost({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return fail("Invalid JSON body");
  }

  const parsed = validateVideoInput(body, { requireSource: true });
  if (parsed.error) return fail(parsed.error, 422);

  await ensureSchema(env);
  const video = await insertVideo(env, parsed.values);
  return Response.json({ video }, { status: 201, headers: { "cache-control": "no-store" } });
}

export function onRequestPut() {
  return methodNotAllowed(["GET", "POST"]);
}
