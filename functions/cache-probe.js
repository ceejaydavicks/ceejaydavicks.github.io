/* TEMPORARY deployment verification probe — removed before the PR is opened. */
import { onRequest as middleware } from "./_middleware.js";
import { deployVersion } from "./_lib/asset-version.js";

async function probe(context, label, path, limit) {
  const origin = new URL(context.request.url).origin;
  const out = [`=== ${label}: ${path} ===`];
  try {
    const response = await fetch(new URL(path, origin), { headers: { "cache-control": "no-cache" } });
    out.push(`status=${response.status}`);
    out.push(`cache-control=${response.headers.get("cache-control")}`);
    out.push(`content-type=${response.headers.get("content-type")}`);
    if (limit > 0) {
      const text = await response.text();
      if (/\.js(\?|$)/.test(path)) out.push(`clean-share=${text.includes("await navigator.share({ url })")}`);
      else out.push(text.slice(0, limit));
    }
  } catch (error) {
    out.push(`SELF-FETCH-FAILED: ${String(error && error.message || error)}`);
  }
  return out.join("\n");
}

export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  const version = await deployVersion(context.env, origin);
  const chunks = [`DEPLOY_VERSION=${version}`];

  /* The exact HTML the root middleware produces for this deployment. */
  try {
    const staticHome = await context.env.ASSETS.fetch(new Request(new URL("/index.html", origin)));
    const homeRequest = new Request(new URL("/", origin), { headers: { "cache-control": "no-cache" } });
    const served = await middleware({
      request: homeRequest,
      env: context.env,
      params: {},
      next: async () => staticHome
    });
    const html = await served.text();
    chunks.push("=== MIDDLEWARE OUTPUT FOR / (REAL DEPLOY ENV) ===");
    chunks.push(`status=${served.status}`);
    chunks.push(`cache-control=${served.headers.get("cache-control")}`);
    chunks.push(`etag=${served.headers.get("etag")}`);
    chunks.push(html.slice(0, 9000));
  } catch (error) {
    chunks.push(`MIDDLEWARE PROBE FAILED: ${String(error && error.stack || error)}`);
  }

  chunks.push(await probe(context, "HOME LIVE", "/", 9000));
  chunks.push(await probe(context, "VERSIONED JS LIVE", `/assets/watch.js?v=${version}`, 0));
  chunks.push(await probe(context, "UNVERSIONED JS LIVE", "/assets/watch.js", 0));
  chunks.push(await probe(context, "VERSIONED CSS LIVE", `/assets/site.css?v=${version}`, 0));
  chunks.push(await probe(context, "UNVERSIONED CSS LIVE", "/assets/site.css", 0));
  chunks.push(await probe(context, "WATCH HTML LIVE", "/watch/?v=62", 9000));
  chunks.push(await probe(context, "IMAGE LIVE", "/assets/favicon-32.png", 0));
  chunks.push(await probe(context, "OLD VERSIONED JS", "/assets/watch.js?v=097bfbd", 0));

  return new Response(chunks.join("\n\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}
