/* GET  /api/videos        – public list (published videos only)
   GET  /api/videos?all=1  – admin list (includes drafts)
   POST /api/videos        – admin create                                            */

import { isAdminRequest } from "../_lib/auth.js";
import { embedThumbnail, syncBotCatalogue } from "../_lib/catalogue.js";
import { ensureSchema, insertVideo, listPublishedVideos, listVideos } from "../_lib/db.js";
import { fail, methodNotAllowed } from "../_lib/http.js";
import { validateVideoInput } from "../_lib/validate.js";

export async function onRequestGet({ request, env }) {
  await ensureSchema(env);

  const wantsAll = new URL(request.url).searchParams.get("all") === "1";
  if (wantsAll && !(await isAdminRequest({ request, env }))) {
    return fail("Unauthorized", 401);
  }

  /* The Telegram bot keeps its own catalogue. It is mirrored into the same
     table the panel edits, so both read one list — the panel used to show
     "0 of 0" while the site showed every bot video. */
  await syncBotCatalogue(env);

  const videos = wantsAll ? await listVideos(env) : await listPublishedVideos(env);
  return new Response(JSON.stringify({ videos }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      /* An edit in the panel has to show up on the site right away, so the
         list is always revalidated. */
      "cache-control": wantsAll ? "no-store" : "public, max-age=0, must-revalidate",
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

  /* A new upload never becomes the featured video on its own: the panel's
     "Set as featured" button is the only thing that pins one. */
  parsed.values.featured = 0;
  parsed.values.pinned = 0;

  /* An embed link brings its own thumbnail (YouTube, Vimeo); everything else
     gets the dark placeholder with the logo, never a black box. */
  if (!parsed.values.thumbnail_url && parsed.values.embed_url) {
    parsed.values.thumbnail_url = await embedThumbnail(parsed.values.embed_url);
    parsed.values.thumb_source = "embed";
  }

  const video = await insertVideo(env, parsed.values);
  return Response.json({ video }, { status: 201, headers: { "cache-control": "no-store" } });
}

export function onRequestPut() {
  return methodNotAllowed(["GET", "POST"]);
}
