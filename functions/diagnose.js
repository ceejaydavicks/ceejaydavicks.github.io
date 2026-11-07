/* TEMPORARY diagnostic probe — removed before the PR is opened. */
const PROD = "https://boootymansion.pages.dev";
const BOT = "https://bootymansionbot.prosperj392.workers.dev";

async function timed(label, url, init) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(12000),
      headers: { "cache-control": "no-cache", ...(init && init.headers) }
    });
    const text = init && init.noBody ? "" : await response.text();
    return {
      label,
      ms: Date.now() - started,
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      cfCache: response.headers.get("cf-cache-status"),
      age: response.headers.get("age"),
      cors: response.headers.get("access-control-allow-origin"),
      contentLength: response.headers.get("content-length"),
      body: init && init.noBody ? "" : text.slice(0, 220)
    };
  } catch (error) {
    return { label, ms: Date.now() - started, error: String(error && error.message || error), name: String(error && error.name || "") };
  }
}

export async function onRequestGet(context) {
  const env = context.env;
  const results = [];
  results.push({
    label: "preview env (no bindings expected)",
    adminPassword: Boolean(env.ADMIN_PASSWORD),
    sessionSecret: Boolean(env.SESSION_SECRET),
    dbBinding: Boolean(env.DB),
    mediaBinding: Boolean(env.MEDIA)
  });

  const paths = [
    ["GET /", PROD + "/"],
    ["GET /api/videos?limit=24", PROD + "/api/videos?limit=24"],
    ["GET /api/videos?limit=24&offset=24", PROD + "/api/videos?limit=24&offset=24"],
    ["GET /api/videos/62", PROD + "/api/videos/62"],
    ["GET /api/settings", PROD + "/api/settings"],
    ["GET /api/health", PROD + "/api/health"],
    ["GET /admin/", PROD + "/admin/"],
    ["GET /assets/site.css", PROD + "/assets/site.css"],
    ["GET /assets/watch.js", PROD + "/assets/watch.js"],
    ["GET bot thumbnail", BOT + "/api/videos/tg-cccdc1f979ac/thumb.jpg"],
    ["GET third-party mp4 (range)", "https://cdn.videy.co/EhYzmbQd1.mp4"]
  ];
  for (const [label, url] of paths) {
    results.push(await timed(label, url, url.endsWith(".mp4") ? { noBody: true, headers: { range: "bytes=0-1023" } } : (url.includes("thumb.jpg") ? { noBody: true } : {})));
  }

  /* Does a correct-password-shaped POST ever hang? Wrong password proves the
     route answers; the browser has no timeout, which is the client bug. */
  results.push(await timed("POST /api/login (wrong password)", PROD + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "admin", origin: PROD },
    body: JSON.stringify({ password: "diagnostic-wrong-password" })
  }));

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}
