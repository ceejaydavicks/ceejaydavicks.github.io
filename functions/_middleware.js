/* Adds baseline security headers to every response (static pages + API). */

export async function onRequest(context) {
  const response = await context.next();

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
