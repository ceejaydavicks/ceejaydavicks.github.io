/* GET  /api/videos                    – public list (lean, 24 per page)
   GET  /api/videos?all=1             – admin list (all rows, includes drafts)
   POST /api/videos                   – admin create

   The public list is edge-cached for 30s (+300s stale-while-revalidate) and
   returns only the fields a card renders — never an upload date. Rows are
   sorted newest-first here in SQL; the browser does the home/shorts reshuffle
   locally, so a cached response can be shared by every visitor. Clients add
   `?shape=nodates2` purely as an edge-cache key so a response written by an
   older deploy (which still contained created_at) can never be served again.

   Mirroring the bot catalogue used to run *inside* this request: an upstream
   fetch with a 6s timeout plus two D1 reads per row. A slow/unreachable bot
   feed therefore made every page load slow (and could exceed the client's
   timeout). It now runs in the background, so it can never hold up a response.
*/

import { isAdminRequest } from "../_lib/auth.js";
import { embedThumbnail, syncBotCatalogue } from "../_lib/catalogue.js";
import {
  ensureSchema, insertVideo, listPublishedCardVideos, listVideos, publicVideo
} from "../_lib/db.js";
import { cachedResponse, FEED_CACHE } from "../_lib/edge-cache.js";
import { fail, methodNotAllowed, toInt } from "../_lib/http.js";
import { validateVideoInput } from "../_lib/validate.js";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const MAX_OFFSET = 100000;

function clamp(value, fallback, min, max) {
  const n = toInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

/* Best-effort background mirror. It is throttled to once a minute inside
   syncBotCatalogue and can never reject into the request path. */
function scheduleBotSync(context) {
  const work = syncBotCatalogue(context.env).catch(() => ({}));
  if (typeof context.waitUntil === "function") context.waitUntil(work);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  await ensureSchema(env);

  const url = new URL(request.url);
  const wantsAll = url.searchParams.get("all") === "1";
  if (wantsAll && !(await isAdminRequest(context))) {
    return fail("Unauthorized", 401);
  }

  /* Admin wants the whole table with every column, immediately, uncached.
     Mirroring the bot catalogue used to be awaited here: a 6s upstream fetch
     plus one D1 read per row held the whole admin page hostage on every load.
     It now runs in the background, exactly like the public feed does. */
  if (wantsAll) {
    scheduleBotSync(context);
    const videos = await listVideos(env);
    return new Response(JSON.stringify({ videos }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }

  const limit = clamp(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(url.searchParams.get("offset"), 0, 0, MAX_OFFSET);

  return cachedResponse(request, async () => {
    scheduleBotSync(context);
    const { videos, total } = await listPublishedCardVideos(env, { limit, offset });
    /* Belt and braces: no upload date (created_at / date / updated_at) is
       ever serialised into a public list response. */
    const publicRows = videos.map(publicVideo);
    return new Response(
      JSON.stringify({
        videos: publicRows,
        total,
        limit,
        offset,
        hasMore: offset + videos.length < total
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": FEED_CACHE,
          "x-content-type-options": "nosniff"
        }
      }
    );
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

  /* An embed link brings its own thumbnail (YouTube, Vimeo). A host with no
     official thumbnail stays empty: that is a real "needs thumbnail" row, so
     the admin can offer an upload and the public site can use its lightweight
     first-frame fallback. Writing the logo placeholder here would make the
     row look like it already had a saved picture. */
  if (!parsed.values.thumbnail_url && parsed.values.embed_url) {
    const official = await embedThumbnail(parsed.values.embed_url);
    if (official) {
      parsed.values.thumbnail_url = official;
      parsed.values.thumb_source = "embed";
    }
  }

  const video = await insertVideo(env, parsed.values);
  return Response.json({ video }, { status: 201, headers: { "cache-control": "no-store" } });
}

export function onRequestPut() {
  return methodNotAllowed(["GET", "POST"]);
}
