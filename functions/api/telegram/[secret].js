/* POST /api/telegram/<SECRET> — the same webhook as /api/telegram, with the
   secret also in the path (`params.secret`), which is how the webhook URL is
   registered with Telegram's setWebhook. The
   X-Telegram-Bot-Api-Secret-Token header is still accepted on its own.

   Routing note: `[secret]` is a single-segment Pages Functions parameter. The
   Next.js-style optional catch-all (`[[path]]`) is avoided here so the route
   stays within the documented single-segment convention.                    */

import { handleTelegram } from "../../_lib/telegram.js";

export async function onRequestPost(context) {
  return handleTelegram(context);
}

export function onRequestGet() {
  return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
}
