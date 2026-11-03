/* GET  /api/videos                    – public list (lean, 24 per page)
   GET  /api/videos?all=1             – admin list (all rows, includes drafts)
   POST /api/videos                   – admin create

   The public list is edge-cached for 60s (+600s stale-while-revalidate) and
   returns only the fields a card renders. The browser does the home/shorts
   reshuffle locally, so a cached response can be shared by every visitor.

   Mirroring the bot catalogue used to run *inside* this request: an upstream
   fetch with a 6s timeout plus two D1 reads per row. A slow/unreachable bot
   feed therefore made every page load slow (and could exceed the client's
   timeout). It now runs in the background, so it can never hold up a response.
*/

import { isAdminRequest } from "../_lib/auth.js";
import { embedThumbnail, syncBotCatalogue } from "../_lib/catalogue.js";
import { ensureSchema, insertVideo, listPublishedCardVideos, listVideos } from "../_lib/db.js";
import { fail, methodNotAllowed, toInt } from "../_lib/http.js";
import { validateVideoInput } from "../_lib/validate.js";

const FEED_CACHE = "public, max-age=60, stale-while-revalidate=600";
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const MAX_OFFSET = 100000;

function clamp(value, fallback, min, max) {
  const n = toInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

/* The Cache API is available on most Workers/Pages runtimes. Guard it so a
   runtime without it still gets the CDN Cache-Control header below. */
function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch (error) {
    return null;
  }
}

async function cachedResponse(request, make) {
  const cache = cacheApi();
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) return hit;
    } catch (error) {
      /* Ignore a cache that is not readable here. */
    }
  }

  const response = await make();
  if (cache && response.status === 200) {
    try {
      await cache.put(request, response.clone());
    } catch (error) {
      /* A cache write must never fail the request. */
    }
  }
  return response;
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

  /* Admin wants the whole table with every column, immediately, uncached. */
  if (wantsAll) {
    await syncBotCatalogue(env);
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
    return new Response(
      JSON.stringify({
        videos,
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
