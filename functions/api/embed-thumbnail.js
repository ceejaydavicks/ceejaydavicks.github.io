/* GET /api/embed-thumbnail?url=… – admin helper.

   Returns the provider's official poster for YouTube / Vimeo embeds, or an
   empty string when the host publishes none. The admin shows that in the form
   preview and, when empty, asks for an upload. It never returns a placeholder
   logo, because that would look like a saved thumbnail. */

import { isAdminRequest } from "../_lib/auth.js";
import { embedThumbnail } from "../_lib/catalogue.js";
import { fail } from "../_lib/http.js";

export async function onRequestGet({ request, env }) {
  if (!(await isAdminRequest({ request, env }))) return fail("Unauthorized", 401);
  const url = new URL(request.url).searchParams.get("url") || "";
  let thumbnail = "";
  if (url) {
    try {
      thumbnail = await embedThumbnail(url);
    } catch (error) {
      thumbnail = "";
    }
  }
  return Response.json(
    { url: thumbnail },
    { headers: { "cache-control": "no-store" } }
  );
}
