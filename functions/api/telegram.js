/* POST /api/telegram — Telegram webhook (header secret).
   See _lib/telegram.js for the full behaviour. */

import { handleTelegram } from "../_lib/telegram.js";

export async function onRequestPost(context) {
  return handleTelegram(context);
}

export function onRequestGet() {
  return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
}
