/* ============================================================================
   Short-lived edge caching for the public JSON APIs.

   Pages Functions do not cache themselves: a `Cache-Control` header alone only
   tells the *browser* what to do. `caches.default` is the Cloudflare edge
   cache, and writing a response there means the next visitor (anywhere) gets
   the JSON without another D1 query. Entries are short-lived and always carry
   stale-while-revalidate, so a new video shows up quickly without a cold D1
   query on every page load.
   ========================================================================== */

export const FEED_CACHE = "public, max-age=30, stale-while-revalidate=300";
export const DETAIL_CACHE = "public, max-age=60, stale-while-revalidate=600";
export const SETTINGS_CACHE = "public, max-age=60, stale-while-revalidate=600";

export function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch (error) {
    return null;
  }
}

/* `make()` must return a Response. Only successful GET-shaped responses are
   stored; a broken cache can never break the site. */
export async function cachedResponse(request, make) {
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
