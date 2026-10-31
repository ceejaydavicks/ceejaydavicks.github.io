/* GET /api/session -> { authenticated } for the admin page. */

import { isAdminRequest } from "../_lib/auth.js";
import { json } from "../_lib/http.js";

export async function onRequestGet({ request, env }) {
  const authenticated = await isAdminRequest({ request, env });
  return json({ authenticated }, 200, { "cache-control": "no-store" });
}
