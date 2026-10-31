/* Adds baseline security headers to every response (static pages + API), and
   turns uncaught Function errors into readable JSON for /api/* requests.

   Why: when a binding or secret is missing, the handler throws and Pages answers
   with a bare 500 and a stack trace. The admin page could only report "Request
   failed (500)". Now a configuration problem comes back as 503 JSON naming the
   exact missing piece, so the login screen can say what to fix.                */

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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
