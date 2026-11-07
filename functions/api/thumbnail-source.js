/* ============================================================================
   GET /api/thumbnail-source?videoId=<id> — admin-only, same-origin video stream.

   The admin's "Fix missing thumbnails" tool captures a frame with a <video>
   element and a canvas. A file on another host taints the canvas unless that
   host sends CORS headers, which most video CDNs do not. Streaming the file
   through this origin makes the whole capture same-origin, so link-added
   videos can get a real thumbnail instead of a "Needs thumbnail" label.

   Only URLs already stored on the video row are fetched. Private/loopback
   hosts are refused, GET + Range are forwarded, and the response is never
   cached. Nothing here writes to the database or to R2.
   ========================================================================== */

import { isAdminRequest } from "../_lib/auth.js";
import { ensureSchema, getVideo } from "../_lib/db.js";
import { fail } from "../_lib/http.js";

const TIMEOUT_MS = 15000;

function privateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return true;
  return host === "localhost" || host.endsWith(".localhost") ||
    host === "127.0.0.1" || host === "::1" || host.endsWith(".internal") ||
    host.startsWith("192.168.") || host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export async function onRequestGet({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);

  const url = new URL(request.url);
  const id = Number.parseInt(String(url.searchParams.get("videoId") || ""), 10);
  if (!Number.isFinite(id) || id <= 0) return fail("Invalid video id");

  await ensureSchema(env);
  const video = await getVideo(env, id);
  if (!video) return fail("Video not found", 404);

  const raw = String(video.video_url || "").trim();
  if (!raw || raw.includes("..") || raw.includes("\\")) {
    return fail("This video has no direct file to capture.", 404);
  }

  /* Files already on this site need no proxy — a redirect keeps the final
     media same-origin and avoids a needless Function subrequest. */
  if (raw.startsWith("/")) {
    return new Response(null, {
      status: 302,
      headers: {
        location: new URL(raw, url.origin).toString(),
        "cache-control": "no-store"
      }
    });
  }

  let target;
  try { target = new URL(raw); } catch (error) { return fail("Invalid video URL", 400); }
  if (target.protocol !== "https:" || privateHost(target.hostname)) {
    return fail("Video host is not allowed.", 400);
  }

  const upstreamHeaders = { accept: "video/*,*/*;q=0.8", "cache-control": "no-cache" };
  const range = request.headers.get("range");
  if (range) upstreamHeaders.range = range;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    return fail("The video host could not be reached. Upload a thumbnail instead.", 502);
  }
  if (!upstream.ok && upstream.status !== 206) {
    return fail(`Video host answered ${upstream.status}. Upload a thumbnail instead.`, 502);
  }

  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") || "video/mp4");
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  for (const name of ["content-length", "content-range", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
