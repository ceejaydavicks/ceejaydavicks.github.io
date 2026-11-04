/* TEMPORARY deployed-runtime smoke probe — removed before the PR is opened. */
export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  const chunks = [];
  async function report(path) {
    try {
      const response = await fetch(origin + path, { headers: { "cache-control": "no-cache" } });
      const text = await response.text();
      chunks.push(
        `=== ${path} ===\nstatus=${response.status}\n` +
        `cache-control=${response.headers.get("cache-control")}\n` +
        `content-type=${response.headers.get("content-type")}\n` +
        text.slice(0, 10000)
      );
    } catch (error) {
      chunks.push(`=== ${path} ===\nFAILED: ${String(error && error.message || error)}`);
    }
  }
  await report("/watch/?v=62");
  await report("/api/share-image?videoId=62");
  await report("/api/media/share/probe.jpg");
  return new Response(chunks.join("\n\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}
