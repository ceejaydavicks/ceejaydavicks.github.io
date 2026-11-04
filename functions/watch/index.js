/* GET /watch/?v=<id> — the public watch page with per-video link previews.
   Also redirects the old /watch?v=<id> (no trailing slash) to the canonical
   URL, preserving the query string. All HTML/markup stays in the static
   watch/index.html; this Function only rewrites head tags. */

import { injectWatchMeta, watchMeta, watchHtmlResponse } from "../_lib/watch-meta.js";

async function staticWatchHtml(context, url) {
  try {
    const next = await context.next();
    if (next && next.ok) return next;
  } catch (error) {
    /* Fall through to the asset binding. */
  }
  try {
    if (context.env && context.env.ASSETS) {
      return await context.env.ASSETS.fetch(new Request(new URL("/watch/index.html", url)));
    }
  } catch (error) {
    /* Nothing else to serve. */
  }
  return null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/watch") {
    url.pathname = "/watch/";
    return new Response(null, {
      status: 301,
      headers: {
        location: url.toString(),
        /* Revalidate instead of pinning the redirect for an hour. A stale
           301 is another way an old deploy can keep serving old HTML. */
        "cache-control": "no-cache"
      }
    });
  }

  const id = String(url.searchParams.get("v") || "").trim();
  const response = await staticWatchHtml(context, url);
  if (!response || !response.ok) {
    return response || new Response("Not found", { status: 404 });
  }
  if (!id) return response;

  const html = await response.text();
  const meta = await watchMeta(env, url.origin, id);
  return watchHtmlResponse(injectWatchMeta(html, meta), response);
}
