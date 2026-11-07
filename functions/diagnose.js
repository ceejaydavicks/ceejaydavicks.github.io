/* TEMPORARY diagnostic probe — removed before the PR is opened. */
const PROD = "https://boootymansion.pages.dev";

async function timed(label, path, init) {
  const started = Date.now();
  try {
    const response = await fetch(PROD + path, {
      ...init,
      signal: AbortSignal.timeout(12000),
      headers: { "cache-control": "no-cache", ...(init && init.headers) }
    });
    const text = await response.text();
    return {
      label,
      ms: Date.now() - started,
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      contentType: response.headers.get("content-type"),
      setCookie: response.headers.get("set-cookie") ? "present" : "none",
      body: text.slice(0, 900)
    };
  } catch (error) {
    return { label, ms: Date.now() - started, error: String(error && error.message || error), name: String(error && error.name || "") };
  }
}

export async function onRequestGet(context) {
  const env = context.env;
  const results = [];
  results.push({
    label: "preview env",
    adminPassword: Boolean(env.ADMIN_PASSWORD),
    sessionSecret: Boolean(env.SESSION_SECRET),
    dbBinding: Boolean(env.DB),
    mediaBinding: Boolean(env.MEDIA),
    branch: env.CF_PAGES_BRANCH || null
  });
  results.push(await timed("GET /api/session", "/api/session"));
  results.push(await timed("GET /api/health", "/api/health"));
  results.push(await timed("GET /api/videos?limit=2", "/api/videos?limit=2"));
  results.push(await timed("GET /api/settings", "/api/settings"));
  results.push(await timed("POST /api/login (wrong password)", "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "admin", origin: PROD },
    body: JSON.stringify({ password: "diagnostic-wrong-password" })
  }));
  results.push(await timed("GET /admin/", "/admin/"));

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}
