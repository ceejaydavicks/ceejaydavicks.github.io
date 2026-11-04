/* ============================================================================
   Deployment-scoped versions for every JS/CSS URL.
   ----------------------------------------------------------------------------
   Cloudflare Pages serves the same /assets/watch.js path on every deploy. A
   browser that cached that path has no reason to ask again, so a fix can be
   live on the server while the phone still runs last week's JavaScript.

   The root middleware uses this module to:

   1. Derive a version for the current deployment from CF_PAGES_COMMIT_SHA
      (falling back to the deployment id in CF_PAGES_URL, then to a hash of the
      actual JS/CSS bytes when neither is available, e.g. `wrangler pages dev`).
   2. Rewrite every local .js/.css URL in the HTML to carry `?v=<version>`, so
      a new deploy always produces new asset URLs.
   3. Tell the middleware which URLs may be cached immutably.

   Nothing here changes page content: only URLs in <script>/<link> tags,
   dynamic import() calls in inline scripts, and one tiny bootstrap script that
   exposes the version to classic scripts that import another module at runtime.
   ========================================================================== */

export const HTML_CACHE_CONTROL = "no-cache";
export const VERSIONED_CACHE_CONTROL = "public, max-age=31536000, immutable";

/* Only our own hex versions qualify for the long immutable cache. A stray
   `?v=1` from a bookmark must never be pinned for a year. */
const VERSION_RE = /^[0-9a-f]{7,40}$/i;

/* Used for the content-hash fallback. Keep in sync with the JS/CSS files that
   are published as static assets; production normally never needs this list
   because CF_PAGES_COMMIT_SHA is present. */
const VERSIONED_FILES = [
  "/assets/age-gate.js",
  "/assets/catalogue.js",
  "/assets/frame-fallback.js",
  "/assets/legal.css",
  "/assets/preloader.css",
  "/assets/preloader.js",
  "/assets/site-nav.js",
  "/assets/site.css",
  "/assets/video-rules.js",
  "/assets/watch.css",
  "/assets/watch.js",
  "/videos.js"
];

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/* Cheap, stable validator for the rewritten HTML. Weak ETags are fine: the
   browser still revalidates on every request because HTML is `no-cache`. */
export function htmlEtag(body) {
  return `W/"${fnv1a(body).toString(16)}-${body.length.toString(16)}"`;
}

function versionFromEnv(env) {
  const sha = String((env && env.CF_PAGES_COMMIT_SHA) || "").trim();
  if (VERSION_RE.test(sha)) return sha.slice(0, 12).toLowerCase();

  /* Preview deployments expose a per-deploy hash as the first host label.
     Production hosts (e.g. boootymansion.pages.dev) are not hex, so they are
     deliberately ignored rather than becoming a permanent version. */
  const deployUrl = String((env && env.CF_PAGES_URL) || "").trim();
  const match = /^https?:\/\/([0-9a-f]{8,})\./i.exec(deployUrl);
  return match ? match[1].slice(0, 12).toLowerCase() : "";
}

let fallbackVersion = null;
let fallbackKey = "";

/* The ASSETS binding is a direct read of the published files, so this works
   both on Cloudflare and in a local `wrangler pages dev` process. It is done
   once per isolate (a new deployment always starts with fresh isolates). */
async function versionFromAssets(env, origin) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") return "";
  if (fallbackVersion && fallbackKey === origin) return fallbackVersion;

  fallbackKey = origin;
  fallbackVersion = (async () => {
    const parts = await Promise.all(VERSIONED_FILES.map(async (path) => {
      try {
        const response = await env.ASSETS.fetch(new Request(new URL(path, origin)));
        if (!response || !response.ok) return path;
        const body = await response.text();
        return `${path}:${body.length}:${fnv1a(body).toString(16)}`;
      } catch (error) {
        return path;
      }
    }));
    return fnv1a(parts.join("|")).toString(16).padStart(8, "0");
  })().catch(() => "");

  return fallbackVersion;
}

/* Returns "" when no trustworthy version exists. In that case URLs are left
   alone and the middleware answers unversioned JS/CSS with `no-cache`, which
   still guarantees fresh bytes (revalidate on every request). */
export async function deployVersion(env, origin) {
  return versionFromEnv(env) || (await versionFromAssets(env, origin));
}

export function isVersionedAsset(url) {
  return VERSION_RE.test(String(url.searchParams.get("v") || ""));
}

function isLocalAsset(value) {
  return !/^(?:https?:)?\/\//i.test(value) &&
    !/^(?:data|blob):/i.test(value);
}

/* Adds (or replaces) `v` on a local JS/CSS URL. Remote URLs, images, fonts,
   fragments and any pre-existing query parameters are left intact. */
function withVersion(value, version) {
  if (!version || !isLocalAsset(value)) return value;

  const hashAt = value.indexOf("#");
  const hash = hashAt >= 0 ? value.slice(hashAt) : "";
  const main = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const queryAt = main.indexOf("?");
  const path = queryAt >= 0 ? main.slice(0, queryAt) : main;
  if (!/\.(?:js|mjs|css)$/i.test(path)) return value;

  const params = new URLSearchParams(queryAt >= 0 ? main.slice(queryAt + 1) : "");
  params.set("v", version);
  return `${path}?${params.toString()}${hash}`;
}

const ATTRIBUTE_RE = /(\b(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi;
const IMPORT_RE = /(\bimport\s*\(\s*)(["'])([^"']+)\2(\s*\))/gi;

/* Rewrites one HTML document. Safe to run twice: `v` is set, never appended. */
export function versionHtml(html, version) {
  if (!version) return html;

  let out = html.replace(ATTRIBUTE_RE, (match, prefix, quote, value) =>
    `${prefix}${quote}${withVersion(value, version)}${quote}`);

  out = out.replace(IMPORT_RE, (match, prefix, quote, value, suffix) =>
    `${prefix}${quote}${withVersion(value, version)}${quote}${suffix}`);

  /* Classic scripts (assets/site-nav.js) cannot see the version in their own
     URL at the moment they run a later dynamic import, so expose it once.
     Remove a previous bootstrap first so running this twice is a no-op. */
  const bootstrap = `<script>window.ASSET_VERSION=${JSON.stringify(version)};</script>`;
  out = out.replace(/<script>window\.ASSET_VERSION=(?:"[^"]*"|'[^']*');<\/script>\s*/gi, "");
  return /<\/head>/i.test(out)
    ? out.replace(/<\/head>/i, `${bootstrap}\n</head>`)
    : bootstrap + out;
}
