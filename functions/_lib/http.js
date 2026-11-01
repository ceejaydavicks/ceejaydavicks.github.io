/* ============================================================================
   HTTP helpers shared by the Pages Functions.
   ========================================================================== */

export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra }
  });
}

export function fail(message, status = 400, extra = {}) {
  return json({ error: message }, status, extra);
}

export function methodNotAllowed(allowed) {
  return fail("Method not allowed", 405, { allow: allowed.join(", ") });
}

/* Text fields are stored as plain text and escaped again when rendered.
   Stripping angle brackets and control characters keeps stored data inert even
   if some future render path forgets to escape. */
export function cleanText(value, max = 200) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function safeHttpUrl(value, max = 2048) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, max);
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch (error) {
    return "";
  }
}

/* Thumbnails may live in R2 (served from /api/media/…), in the site's own
   static files (/assets/…, used for the embed placeholder) or on another host. */
export function safeAssetUrl(value, max = 2048) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, max);
  if (!trimmed) return "";
  if (trimmed.startsWith("/api/media/") || trimmed.startsWith("/assets/")) {
    return trimmed.includes("..") || trimmed.includes("\\") ? "" : trimmed;
  }
  return safeHttpUrl(trimmed, max);
}

export function toInt(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

export function boolInt(value) {
  if (value === true || value === 1 || value === "1") return 1;
  return 0;
}
