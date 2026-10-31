/* POST /api/logout -> clears the admin session cookie. */

import { clearedSessionCookie } from "../_lib/auth.js";
import { json } from "../_lib/http.js";

export async function onRequestPost({ request }) {
  return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(request) });
}
