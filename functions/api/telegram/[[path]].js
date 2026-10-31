/* POST /api/telegram/<SECRET> — same webhook with the secret also in the path.
   The header (X-Telegram-Bot-Api-Secret-Token) is still required or honoured. */

import { handleTelegram } from "../../_lib/telegram.js";

export async function onRequestPost(context) {
  return handleTelegram(context);
}

export function onRequestGet() {
  return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
}
