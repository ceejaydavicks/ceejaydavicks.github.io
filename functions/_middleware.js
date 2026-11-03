/* Adds baseline security headers to every response (static pages + API), and
   turns uncaught Function errors into readable JSON for /api/* requests.

   Why: when a binding or secret is missing, the handler throws and Pages answers
   with a bare 500 and a stack trace. The admin page could only report "Request
   failed (500)". Now a configuration problem comes back as 503 JSON naming the
   exact missing piece, so the login screen can say what to fix.                */

import { injectWatchMeta, watchMeta, watchHtmlResponse } from "./_lib/watch-meta.js";

const MAX_DETAIL = 300;

function cleanDetail(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL);
}

/* Configuration problems name a binding or a secret — never its value — so they
   are safe to show, and are reported as 503 ("not set up yet") rather than 500. */
function isConfigurationError(detail) {
  return /missing d1 binding|r2 bucket is not configured|admin_password|session_secret|telegram bot is not configured|no telegram admins|not configured/i.test(
    detail
  );
}

function errorResponse(request, error) {
  const path = new URL(request.url).pathname;
  const detail = cleanDetail(error && error.message ? error.message : error) || "Unknown error";
  const configuration = isConfigurationError(detail);

  if (!path.startsWith("/api/")) {
    return new Response(configuration ? detail : "Internal Server Error", {
      status: configuration ? 503 : 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }

  return new Response(
    JSON.stringify({
      error: configuration ? detail : "Server error",
      detail,
      code: configuration ? "configuration_error" : "server_error",
      hint: "Open /api/health on this site to see which binding or secret is missing."
    }),
    {
      status: configuration ? 503 : 500,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    }
  );
}

export async function onRequest(context) {
  let response;

  try {
    response = await context.next();
  } catch (error) {
    response = errorResponse(context.request, error);
  }

  if (response.status === 204 || response.status === 304) return response;

  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "SAMEORIGIN");
  headers.set("permissions-policy", "geolocation=(), microphone=(), camera=(), payment=()");

  // The admin page is noindex in its own <meta> too; this covers the headers.
  const path = new URL(context.request.url).pathname;
  if (path === "/admin" || path.startsWith("/admin/")) {
    headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  }
  if (path.startsWith("/api/")) {
    headers.set("x-robots-tag", "noindex");
  }

  /* The watch URL must always be a page, never a download. The dedicated
     watch Function also removes this header; this is the belt-and-braces
     path for deployments where only the middleware matches /watch/. */
  const isWatch = path === "/watch" || path.startsWith("/watch/");
  if (isWatch) {
    headers.delete("content-disposition");

    /* If the dedicated watch Function did not run (route matching differs
       between Pages projects), inject the social preview tags here as a
       fallback. injectWatchMeta is idempotent, so running it in both places
       is harmless. */
    const id = String(new URL(context.request.url).searchParams.get("v") || "").trim();
    const contentType = String(response.headers.get("content-type") || "");
    if (id && response.status === 200 && contentType.includes("text/html")) {
      try {
        const html = await response.text();
        // If the dedicated watch Function already ran, its og:url tag is
        // present — reuse its work instead of querying D1 a second time.
        if (!/<meta\s+property="og:url"/i.test(html)) {
          const meta = await watchMeta(context.env, new URL(context.request.url).origin, id);
          return watchHtmlResponse(injectWatchMeta(html, meta), response);
        }
        return watchHtmlResponse(html, response);
      } catch (error) {
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
