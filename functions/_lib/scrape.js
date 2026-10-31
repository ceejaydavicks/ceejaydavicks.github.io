/* ============================================================================
   Link scraper for the Telegram bot (and anything else that needs it).

   Given a page URL it works out what is playable and returns ready-to-publish
   items — no database, no network side effects beyond the page fetches:

     { items: [{ title, sourceUrl, sourceKind, thumbnail, durationSec,
                 description, site, tags }], site, pageTitle }
     { error }

   `sourceKind` says how to play it:
     file  — a direct video file (../x.mp4), safe to mirror into R2
     embed — a player page (a tube's /embed/…), stored as embed_url
     page  — nothing better than the page itself (the post, not the video)

   The order of attack mirrors what a browser sees, cheapest first:
     1. schema.org VideoObject JSON-LD (single videos and galleries)
     2. an anchor scan, for listings that expose no structured data
     3. the page itself: og:video, <video>/<source>, iframe players,
        JS player configs (`sources: [{ file: "…mp4" }]`)
     4. salvage passes: known-tube embeds derived from the URL alone,
        the WordPress REST API, and one level of iframe chasing.

   Ported from the AfterDark worker template (Nior122/Afterdark) and trimmed
   to this site's data model (duration is a display string, one `tag`).
   ========================================================================== */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PAGE_TIMEOUT_MS = 15000;
const EMBED_TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 900000;
/* Cloudflare allows a limited number of subrequests per request (50 on the free
   plan) and every mirrored file + poster costs one, so a listing is capped. */
const MAX_ITEMS = 12;
export const MAX_URLS = 3;

/* ------------------------------- utilities -------------------------------- */

export function hostOf(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./i, "");
  } catch (error) {
    return "";
  }
}

/* Same page, same key: trailing slashes and fragments never mean a repost. */
export function normaliseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

export function extractUrls(text, limit = MAX_URLS) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const seen = new Set();
  const urls = [];
  for (const match of matches) {
    const url = match.replace(/[.,;:!?]+$/, "");
    const key = normaliseUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function titleCase(value) {
  return String(value || "").replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

/* ------------------------------ page fetching ----------------------------- */

/* Fetch a page the way a browser would; returns { html, finalUrl } or { error }. */
export async function fetchPage(url, timeoutMs = PAGE_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { error: `the page answered HTTP ${response.status}` };

    const type = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      return { error: `that link is not a web page (${type.split(";")[0] || "unknown type"})` };
    }

    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    return { html, finalUrl: response.url || url };
  } catch (error) {
    return { error: error && error.name === "TimeoutError" ? "the page timed out" : "the page could not be reached" };
  }
}

/* --------------------------------- markup -------------------------------- */

export function decodeEntities(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", rsquo: "\u2019",
    lsquo: "\u2018", ldquo: "\u201C", rdquo: "\u201D", laquo: "\u00AB",
    raquo: "\u00BB", middot: "\u00B7"
  };
  return String(value || "").replace(/&#(\d+);|&#x([0-9a-f]+);|&([a-z]+);/gi, (match, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec) || 32);
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16) || 32);
    const mapped = named[String(name).toLowerCase()];
    return mapped === undefined ? match : mapped;
  });
}

export function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(String(html || ""));
    if (match) return decodeEntities(match[1]).trim();
  }
  return "";
}

export function cleanTitle(value) {
  return decodeEntities(stripTags(value)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function normBrand(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\.[a-z]{2,}(?:\.[a-z]{2,3})?$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isBrandOnly(title, site, host) {
  const value = normBrand(title);
  if (!value) return true;
  return value === normBrand(site) || value === normBrand(host);
}

/* "Real Headline – SiteName" -> "Real Headline". Blogs brand their titles, and
   the brand segment carries no information about the video. */
function debrandTitle(title, site, host) {
  const text = String(title || "").trim();
  if (!text) return "";
  const brands = [normBrand(site), normBrand(host)].filter(Boolean);
  if (!brands.length) return text;

  const at = Math.max(
    text.lastIndexOf(" | "), text.lastIndexOf(" \u2013 "), text.lastIndexOf(" \u2014 "),
    text.lastIndexOf(" \u00B7 "), text.lastIndexOf(" \u2022 "), text.lastIndexOf(" - ")
  );
  if (at > 0) {
    const head = text.slice(0, at).trim();
    const tail = text.slice(at).replace(/^\s*[|\u00B7\u2022\u2013\u2014-]\s*/, "").trim();
    if (head && brands.includes(normBrand(tail))) return head;
  }

  const lead = /^([^|\u00B7\u2022\u2013\u2014-]{2,60}?)\s*(?:[|\u00B7\u2022]|\s[-\u2013\u2014]\s)\s*(.+)$/.exec(text);
  if (lead && lead[2].trim() && brands.includes(normBrand(lead[1]))) return lead[2].trim();
  return text;
}

function collectTags(...sources) {
  const tags = [];
  for (const source of sources) {
    if (!source) continue;
    const parts = Array.isArray(source) ? source : String(source).split(/[,;|]/);
    for (const part of parts) {
      const tag = titleCase(stripTags(part).replace(/^#/, "").trim());
      if (tag.length >= 2 && tag.length <= 28 && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags.slice(0, 10);
}

/* ------------------------------- json-ld --------------------------------- */

function jsonLdVideoObjects(html) {
  const objects = [];
  const blocks = String(html || "").matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of blocks) {
    const raw = block[1].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      continue;
    }
    const walk = (node, depth = 0) => {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1));
        return;
      }
      if (typeof node !== "object") return;
      const type = node["@type"];
      const types = Array.isArray(type) ? type.map(String) : [String(type || "")];
      if (types.some((entry) => /videoobject/i.test(entry))) objects.push(node);
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") walk(value, depth + 1);
      }
    };
    walk(parsed);
  }
  return objects;
}

function firstString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const key of ["url", "contentUrl", "@id", "name"]) {
      const found = firstString(value[key]);
      if (found) return found;
    }
  }
  return "";
}

/* -------------------------------- duration ------------------------------- */

export function parseDurationToSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const raw = String(value || "").trim();
  if (!raw) return 0;

  const iso = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(raw);
  if (iso) {
    const [, d, h, m, s] = iso;
    return Math.round(Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0));
  }
  if (/^\d+$/.test(raw)) return Number(raw);

  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (clock) {
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), Number(clock[3] || 0)];
    return clock[3] ? a * 3600 + b * 60 + c : a * 60 + b;
  }
  return 0;
}

function extractDurationSeconds(html) {
  const source = String(html || "");
  const first = (pattern) => {
    const match = pattern.exec(source);
    return match ? match[1] : "";
  };

  const candidates = [
    first(/<video\b[^>]*\bduration=["']([^"']+)["']/i),
    first(/<video\b[^>]*\bdata-duration=["']([^"']+)["']/i),
    first(/["'](?:duration|durationSec|duration_sec|video_duration|length_sec)["']\s*:\s*["']?([0-9]+(?::[0-9]{2}){1,2}|P[^"'\s,}]+|[0-9]+(?:\.[0-9]+)?)["']?/i),
    first(/(?:duration|video_duration|length)\s*[:=]\s*["']([0-9]+(?::[0-9]{2}){1,2})["']/i),
    metaContent(source, "og:video:duration")
  ];

  for (const candidate of candidates) {
    const seconds = parseDurationToSeconds(candidate);
    if (seconds > 0 && seconds < 24 * 3600) return seconds;
  }
  return 0;
}

/* ------------------------------- media URLs ------------------------------ */

/* Direct media URL hidden in a JS player config or a data- attribute. The
   common shape on video blogs (Fluid Player, jwplayer, VPS): no og:video meta
   and no <video src> — the file lives in a script config like
   `sources: [{ file: "…/clip.mp4" }]`. */
function firstMediaFileUrl(html, pageUrl) {
  const ext = "(?:mp4|webm|m4v|ogv)(?:\\\\?[^\"'\\\\)\\s]*)?";
  const patterns = [
    new RegExp(`\\bfile["']?\\s*:\\s*["']([^"'\\\\)]+\\.${ext})["']`, "i"),
    new RegExp(`\\b(?:src|url|video_url|mp4)\\s*[:=]\\s*["']([^"'\\\\)]+\\.${ext})["']`, "i"),
    new RegExp(`data-(?:file|src|video|url)\\s*=\\s*["']([^"'\\\\)]+\\.${ext})["']`, "i"),
    new RegExp(`["'](https?:\\/\\/[^"'\\\\)]+\\.${ext})["']`, "i"),
    new RegExp(`["'](\\/[^"'\\s]*?\\.(?:mp4|webm|m4v|ogv)(?:\\?[^"'\\s]*)?)["']`, "i")
  ];

  /* Page builders serialise player configs as JSON, so the URL only appears
     with escaped slashes (https:\/\/cdn…mp4) or percent-encoded inside a
     redirect wrapper — plain scans miss both. */
  const unescaped = String(html || "").replace(/\\\//g, "/");
  const haystacks = [unescaped];
  try {
    const decoded = decodeURIComponent(unescaped);
    if (decoded !== unescaped) haystacks.push(decoded);
  } catch (error) {
    /* malformed % sequences: the raw scan already covers what is findable */
  }

  for (const haystack of haystacks) {
    for (const pattern of patterns) {
      const match = pattern.exec(haystack);
      if (!match) continue;
      let absolute;
      try {
        absolute = new URL(decodeEntities(match[1]), pageUrl).toString();
      } catch (error) {
        continue;
      }
      if (normaliseUrl(absolute) === normaliseUrl(pageUrl)) continue;
      return absolute;
    }
  }
  return "";
}

/* Player poster: player-specific signals first (JSON-LD VideoObject, poster
   attributes, config scans); generic og:/twitter: images only as a fallback,
   because on blogs those are often just the site logo. */
export function firstPosterImageUrl(html, pageUrl) {
  const markup = String(html || "");
  const candidates = [];
  const fallbacks = [];
  const add = (value, fallback = false) => {
    const raw = String(value || "").trim();
    if (raw) (fallback ? fallbacks : candidates).push(raw);
  };
  const attribute = (tag, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    if (!match) return "";
    return match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3] || "";
  };

  for (const match of markup.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, "property") || attribute(tag, "name") || attribute(tag, "itemprop");
    if (/^(?:og:image(?::(?:secure_url|url))?|twitter:image(?::src)?|image|thumbnail(?:url)?)$/i.test(key)) {
      add(attribute(tag, "content"), true);
    }
  }

  for (const match of markup.matchAll(/<link\b[^>]*>/gi)) {
    if (/\bimage_src\b/i.test(attribute(match[0], "rel"))) add(attribute(match[0], "href"), true);
  }

  for (const match of markup.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const walk = (node, depth = 0) => {
        if (!node || depth > 6) return;
        if (Array.isArray(node)) {
          node.forEach((item) => walk(item, depth + 1));
          return;
        }
        if (typeof node !== "object") return;
        const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
        if (types.some((entry) => /videoobject/i.test(String(entry || "")))) {
          const collect = (value) => {
            if (typeof value === "string") add(value);
            else if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value === "object") {
              collect(value.url);
              collect(value.contentUrl);
            }
          };
          collect(node.thumbnailUrl);
          collect(node.image);
        }
        Object.values(node).forEach((value) => {
          if (value && typeof value === "object") walk(value, depth + 1);
        });
      };
      walk(parsed);
    } catch (error) {
      /* malformed JSON-LD: skip */
    }
  }

  for (const match of markup.matchAll(/<video\b[^>]*>/gi)) {
    add(attribute(match[0], "poster"));
    add(attribute(match[0], "data-poster"));
  }

  for (const match of markup.matchAll(/<[^>]+>/g)) {
    const tag = match[0];
    const label = `${attribute(tag, "class")} ${attribute(tag, "id")}`;
    if (!/\bdata-(?:poster|thumbnail|thumb|preview|image)(?:-url)?\s*=/i.test(tag)) continue;
    if (label.trim() && !/video|player|poster|thumb|preview|media|cover/i.test(label)) continue;
    for (const name of [
      "data-poster", "data-poster-url", "data-thumbnail", "data-thumbnail-url",
      "data-thumb", "data-thumb-url", "data-preview", "data-image"
    ]) {
      add(attribute(tag, name));
    }
  }

  const config = markup.replace(/\\\//g, "/");
  const configPattern =
    /(?:["']?(?:poster|posterUrl|poster_url|thumbnail|thumbnailUrl|thumbnail_url|thumb|thumbUrl|thumb_url|previewImage|preview_image|image)["']?)\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of config.matchAll(configPattern)) add(match[1]);

  for (const match of markup.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const tag = match[0];
    const label = [attribute(tag, "class"), attribute(tag, "id"), attribute(tag, "alt"), attribute(tag, "title")].join(" ");
    if (!/video|player|poster|thumb|preview|cover|media/i.test(label)) continue;
    for (const name of ["data-poster", "data-thumbnail", "data-thumb", "data-src", "data-lazy-src", "data-original", "src", "srcset"]) {
      const value = attribute(tag, name);
      if (!value) continue;
      add(name === "srcset" ? value.split(",")[0].trim().split(/\s+/)[0] : value);
      break;
    }
  }

  for (const candidate of [...candidates, ...fallbacks]) {
    let value = decodeEntities(candidate).replace(/\\\//g, "/").trim();
    value = value.replace(/^url\(\s*["']?(.+?)["']?\s*\)$/i, "$1").replace(/^["']|["']$/g, "");
    if (!value || /^(?:data|blob|javascript):/i.test(value)) continue;
    if (!/^(?:https?:)?\/\//i.test(value) && !value.startsWith("/") && !/[/?#]/.test(value) &&
        !/\.(?:jpe?g|png|webp|gif|avif|bmp)(?:$|[?#])/i.test(value)) continue;

    let absolute;
    try {
      absolute = new URL(value, pageUrl);
    } catch (error) {
      continue;
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
    if (/\.(?:mp4|webm|m4v|ogv|mov|m3u8|mpd)(?:$|\?)/i.test(absolute.pathname)) continue;
    if (/(?:^|[/_-])(?:avatar|favicon|sprite|placeholder|logo|icon)(?:[/_.-]|$)/i.test(absolute.pathname)) continue;
    return absolute.toString();
  }
  return "";
}

/* --------------------------- player discovery ---------------------------- */

/* Playable source for a scraped item: a direct file, or an embeddable player. */
function pickSourceUrl(candidates, pageUrl) {
  for (const candidate of candidates) {
    let url = String(candidate || "").trim();
    if (!url) continue;
    if (/^\/\//.test(url) && pageUrl) {
      try {
        url = new URL(url, pageUrl).toString();
      } catch (error) {
        /* keep the raw value; the http test below rejects it */
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\.(mp4|webm|ogg|mov|m4v)(\?|$)/i.test(url)) return { sourceUrl: url, kind: "file" };
    if (/(\/embed\/|\/e\/|player\.|embed\.|youtube\.com\/embed|player\.vimeo\.com)/i.test(url)) {
      return { sourceUrl: url, kind: "embed" };
    }
  }
  return null;
}

/* Tubes whose embed URL is derivable from the watch link — salvage for pages
   that block bot fetches or mount the player only through JS. */
const KNOWN_EMBED_HOSTS = [
  {
    host: /^eporner\.com$/i,
    watch: /(?:^|\/)video-([A-Za-z0-9]+)/i,
    embed: (match) => `https://www.eporner.com/embed/${match[1]}/`
  },
  {
    host: /^iceporn\.com$/i,
    watch: /\/(?:video|embed)\/(\d+)/i,
    embed: (match) => `https://www.iceporn.com/embed/${match[1]}`
  },
  {
    host: /^(?:videopress\.com|(?:videos?|w)\.wordpress\.com)$/i,
    watch: /\/v\/([A-Za-z0-9]+)/i,
    embed: (match) => `https://videopress.com/embed/${match[1]}`
  },
  {
    host: /^xvideos\.com$/i,
    watch: /\/(?:video(\d+)|embedframe\/(\d+))/i,
    embed: (match) => `https://www.xvideos.com/embedframe/${match[1] || match[2]}`
  }
];

export function knownEmbedFor(url) {
  const host = hostOf(url);
  if (!host) return null;
  for (const site of KNOWN_EMBED_HOSTS) {
    if (!site.host.test(host)) continue;
    const match = site.watch.exec(String(url));
    if (match) return { sourceUrl: site.embed(match), kind: "embed" };
  }
  return null;
}

/* First iframe whose src points at a known player, including protocol-relative
   and redirect-wrapped (`…/redirect?target_url=https%3A%2F%2F…`) values. */
function firstKnownFrameEmbed(html, pageUrl) {
  for (const match of String(html || "").matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const raw = decodeEntities(match[1]).trim();
    if (!raw || /^javascript:/i.test(raw)) continue;

    let absolute = "";
    try {
      absolute = new URL(raw, pageUrl).toString();
    } catch (error) {
      continue;
    }
    const direct = knownEmbedFor(absolute);
    if (direct) return direct;

    let decoded = "";
    try {
      decoded = decodeURIComponent(absolute);
    } catch (error) {
      decoded = "";
    }
    if (decoded && decoded !== absolute) {
      const viaRedirect = knownEmbedFor(decoded);
      if (viaRedirect) return viaRedirect;
    }
  }
  return null;
}

/* "…/video-abc123/viral-couple/" -> "Viral Couple": a title for embed-only
   items when the page itself could not be read. */
function titleFromWatchUrl(url) {
  try {
    const path = new URL(url).pathname;
    const slug = path.split("/").filter(Boolean).pop() || "";
    const words = slug
      .replace(/^video-[A-Za-z0-9]+-?/i, "")
      .replace(/\.(html?|php|aspx?)$/i, "")
      .replace(/[-_+]+/g, " ")
      .trim();
    return words.length >= 3 ? cleanTitle(titleCase(words)).slice(0, 180) : "";
  } catch (error) {
    return "";
  }
}

/* ------------------------ WordPress REST salvage ------------------------- */

const WP_HINT = /\/wp-content\/|wp-json|generator["']\s*content=["']WordPress/i;

async function fetchJson(url, timeoutMs = 8000) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

function wpSlugFromUrl(pageUrl) {
  try {
    const path = new URL(pageUrl).pathname;
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop() || "";
    if (!last) return "";
    if (/\.(?:html?|php|aspx?)$/i.test(last)) {
      return last.replace(/\.(?:html?|php|aspx?)$/i, "");
    }
    if (parts.length && /^\d{4}$/.test(parts[0])) return last;
    return last;
  } catch (error) {
    return "";
  }
}

/* The REST API often still has the raw post content (file URL) and the true
   poster, even when the HTML served to bots is obfuscated or empty. */
async function wpRestRescue(pageUrl) {
  const slug = wpSlugFromUrl(pageUrl);
  if (!slug) return null;

  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch (error) {
    return null;
  }

  const posts = await fetchJson(`${origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`);
  const post = Array.isArray(posts) ? posts[0] : null;
  if (!post) return null;

  let fields = "";
  for (const key of ["meta", "acf"]) {
    try {
      fields = `${fields}\n${JSON.stringify(post[key] || {})}`;
    } catch (error) {
      /* ignore circular/oversized payloads */
    }
  }

  const content = `${(post.content && post.content.rendered) || ""}\n${(post.excerpt && post.excerpt.rendered) || ""}\n${fields}`;
  const fileUrl = firstMediaFileUrl(content, post.link || pageUrl);

  const rawFrame = /<iframe\b[^>]*\bsrc=["']([^"']+)["']/i.exec(content);
  let playerUrl = "";
  if (rawFrame) {
    try {
      playerUrl = new URL(decodeEntities(rawFrame[1]), post.link || pageUrl).toString();
    } catch (error) {
      playerUrl = "";
    }
  }

  let thumb =
    firstPosterImageUrl(content, post.link || pageUrl) ||
    (post.jetpack_featured_media_url || "") ||
    (post.better_featured_image && post.better_featured_image.source_url) ||
    (post.yoast_head_json && post.yoast_head_json.og_image && post.yoast_head_json.og_image[0]
      ? post.yoast_head_json.og_image[0].url
      : "");

  if (!thumb && post.featured_media) {
    const media = await fetchJson(`${origin}/wp-json/wp/v2/media/${post.featured_media}`);
    thumb = media && typeof media.source_url === "string" ? media.source_url : "";
  }

  const title = post.title && post.title.rendered ? cleanTitle(post.title.rendered) : "";
  const durationSec = extractDurationSeconds(content);

  if (!fileUrl && !playerUrl && !thumb && !title && !durationSec) return null;
  return { fileUrl, playerUrl, thumb: thumb || "", title, durationSec };
}

/* ------------------------------ page parsing ----------------------------- */

/* Parse one page into items. Exported so tests (and future admin tooling) can
   run it against saved markup without any network access. */
export function scrapePage(html, pageUrl) {
  const host = hostOf(pageUrl);
  const site = metaContent(html, "og:site_name") || host;
  const rawTitle = metaContent(html, "og:title") ||
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || "")) || [])[1] || "";
  const pageTitle = debrandTitle(cleanTitle(rawTitle), site, host);
  const pageThumb = firstPosterImageUrl(html, pageUrl);
  const pageDescription = metaContent(html, "og:description") || metaContent(html, "description") || "";
  const pageKeywords = metaContent(html, "keywords");
  const pathHint = (() => {
    try {
      return decodeURIComponent(new URL(pageUrl).pathname);
    } catch (error) {
      return "";
    }
  })();

  const items = [];
  const seen = new Set();
  const push = (item) => {
    const key = normaliseUrl(item.sourceUrl || item.title.toLowerCase());
    if (!item.title || item.title.length < 3 || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  /* 1) schema.org VideoObject entries — single videos and ItemList galleries. */
  for (const node of jsonLdVideoObjects(html)) {
    const title = cleanTitle(firstString(node.name) || firstString(node.headline));
    if (!title) continue;
    const source = pickSourceUrl(
      [firstString(node.contentUrl), firstString(node.embedUrl), firstString(node.url)],
      pageUrl
    );
    push({
      title,
      sourceUrl: (source && source.sourceUrl) || pageUrl,
      sourceKind: (source && source.kind) || "page",
      thumbnail: firstString(node.thumbnailUrl) || firstString(node.image) || pageThumb,
      description: stripTags(firstString(node.description) || "").slice(0, 600),
      durationSec: parseDurationToSeconds(node.duration),
      tags: collectTags(node.genre, node.keywords),
      site
    });
  }

  const structuredCount = items.length;

  /* 2) Anchor scan — catches galleries that expose no structured data. */
  if (items.length < 2) {
    const anchorPattern = /<a\b([^>]*)>([\s\S]{0,600}?)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(String(html || "")))) {
      const attrs = match[1];
      const inner = match[2];
      const href = /\bhref=["']([^"']+)["']/i.exec(attrs);
      if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href[1])) continue;

      let absolute;
      try {
        absolute = new URL(decodeEntities(href[1]), pageUrl).toString();
      } catch (error) {
        continue;
      }
      if (hostOf(absolute) !== host) continue;

      const linkPath = new URL(absolute).pathname;
      /* Nav chrome is never a video: WordPress gives the site logo
         alt="<site name>", which used to become the page's only "video". */
      if (/^\/?(?:index|home|default)?(?:\.(?:html?|php))?$/i.test(linkPath)) continue;

      const looksLikeVideo =
        /\/(video|videos|watch|embed|v|clip|post|p)\/[^/]/i.test(linkPath) ||
        /[?&](v|video|id|watch)=/i.test(absolute);

      const imgTag = (/<img\b[^>]*>/i.exec(inner) || [])[0] || "";
      const imgAlt = imgTag ? (/\balt=["']([^"']*)["']/i.exec(imgTag) || [])[1] || "" : "";
      const imgSrc = imgTag ? (/\bsrc=["']([^"']+)["']/i.exec(imgTag) || [])[1] || "" : "";
      const titleAttr = (/\btitle=["']([^"']*)["']/i.exec(attrs) || [])[1] || "";
      const text = stripTags(inner);

      if (!looksLikeVideo && !(imgTag && (imgAlt || titleAttr))) continue;

      const title = cleanTitle(titleAttr || imgAlt || text.split(/\s{2,}/)[0] || "");
      if (!title || title.length < 4 || title.length > 160) continue;

      let thumbnail = "";
      if (imgSrc) {
        try {
          thumbnail = new URL(decodeEntities(imgSrc), pageUrl).toString();
        } catch (error) {
          thumbnail = "";
        }
      }

      push({
        title,
        sourceUrl: absolute,
        sourceKind: "page",
        thumbnail,
        description: "",
        durationSec: 0,
        tags: [],
        site
      });
    }
  }

  /* 3) The page itself as a single video — because nothing structured was
     found, or because the anchor scan only produced gallery siblings while
     THIS page carries the playable source. */
  if (pageTitle) {
    const source = pickSourceUrl(
      [
        metaContent(html, "og:video:secure_url"),
        metaContent(html, "og:video:url"),
        metaContent(html, "og:video"),
        (() => {
          const tag = /<video\b[^>]*src=["']([^"']+)["']/i.exec(String(html || ""));
          return tag ? tag[1] : "";
        })(),
        (() => {
          const tag = /<source\b[^>]*src=["']([^"']+)["']/i.exec(String(html || ""));
          return tag ? tag[1] : "";
        })(),
        (() => {
          const frame = /<iframe\b[^>]*src=["']([^"']+)["']/i.exec(String(html || ""));
          return frame ? frame[1] : "";
        })(),
        firstMediaFileUrl(html, pageUrl)
      ],
      pageUrl
    );

    if (!items.length || (!structuredCount && source && source.kind)) {
      if (items.length) {
        items.length = 0;
        seen.clear();
      }
      /* A brand-only title says nothing about the video; the permalink carries
         the real headline in its last path segment. */
      const usableTitle = (isBrandOnly(pageTitle, site, host) && titleFromWatchUrl(pageUrl)) || pageTitle;
      push({
        title: usableTitle,
        sourceUrl: (source && source.sourceUrl) || pageUrl,
        sourceKind: (source && source.kind) || "page",
        thumbnail: pageThumb,
        description: stripTags(pageDescription).slice(0, 600),
        durationSec: parseDurationToSeconds(metaContent(html, "og:video:duration")),
        tags: collectTags(pageKeywords),
        site
      });
    }
  }

  /* `truncated` lets the caller say "there are more" instead of silently
     publishing only the first page of a gallery. */
  return {
    items: items.slice(0, MAX_ITEMS),
    site,
    pageTitle,
    truncated: items.length > MAX_ITEMS
  };
}

/* --------------------------- iframe player chase ------------------------- */

/* Last generic try for posts that only embed a third-party player page: follow
   the most player-looking iframe and run the pipeline against it. Capped at two
   frames, same-origin frames skipped, so this can neither recurse nor hammer
   the publisher. */
async function chaseIframePlayer(html, pageUrl) {
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch (error) {
    return null;
  }

  const sources = [...String(html || "").matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => decodeEntities(match[1]).trim())
    .filter((src) => src && !/^(?:javascript|data|blob):/i.test(src));

  const ranked = sources
    .map((src) => ({ src, rank: /video|player|embed|media|watch|press/i.test(src) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 2);

  for (const entry of ranked) {
    let absolute = "";
    try {
      absolute = new URL(entry.src, pageUrl).toString();
    } catch (error) {
      continue;
    }
    if (absolute.startsWith(origin)) continue;

    const known = knownEmbedFor(absolute);
    if (known) return { ...known, thumbnail: "" };

    let decoded = "";
    try {
      decoded = decodeURIComponent(absolute);
    } catch (error) {
      decoded = "";
    }
    if (decoded && decoded !== absolute) {
      const viaRedirect = knownEmbedFor(decoded);
      if (viaRedirect) return { ...viaRedirect, thumbnail: "" };
    }

    const inner = await fetchPage(absolute, EMBED_TIMEOUT_MS);
    if (inner.error) continue;

    const parsed = scrapePage(inner.html, inner.finalUrl || absolute);
    const playable = parsed.items.find((item) => item.sourceKind && item.sourceKind !== "page");
    if (playable) {
      if (!playable.thumbnail) playable.thumbnail = firstPosterImageUrl(inner.html, inner.finalUrl || absolute);
      return playable;
    }
  }
  return null;
}

/* ------------------------------- public API ------------------------------ */

/* A link that IS the file needs no page: mirror it and publish. */
const DIRECT_FILE = /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i;

function titleFromFileUrl(url) {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    const words = decodeURIComponent(name)
      .replace(/\.[^.]+$/, "")
      .replace(/[-_.+]+/g, " ")
      .trim();
    const title = cleanTitle(titleCase(words));
    if (title.length >= 3) return title;
  } catch (error) {
    /* fall through to the host */
  }
  return `Video from ${hostOf(url) || "the web"}`;
}

/**
 * Scrape one URL into publishable items.
 * -> { error } | { items, site, pageTitle, finalUrl }
 */
export async function scrapeUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { error: "That does not look like a link — it should start with http:// or https://" };
  }

  /* Private Telegram targets can never be scraped: /c/… pages open only for
     members and invite links are not pages at all. Refusing them before any
     outbound request turns a multi-second hang into an instruction. */
  if (/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.dog)\/(?:c\/\d+|joinchat\/|\+)/i.test(url)) {
    return {
      error:
        "That is a private Telegram link — neither the bot nor the dashboard can read it. " +
        "Make the channel public and re-copy the post link (https://t.me/<name>/<id>), " +
        "or send a link to the file/embed page instead."
    };
  }

  /* A direct media link is already the video. */
  if (DIRECT_FILE.test(url)) {
    const title = titleFromFileUrl(url);
    return {
      items: [{
        title,
        sourceUrl: url,
        sourceKind: "file",
        thumbnail: "",
        description: "",
        durationSec: 0,
        tags: [],
        site: hostOf(url)
      }],
      site: hostOf(url),
      pageTitle: title,
      finalUrl: url
    };
  }

  const embed = knownEmbedFor(url);
  const page = await fetchPage(url);
  if (page.error) {
    /* A known tube still yields a playable embed without reading the page. */
    /* Some hosts serve a file without the extension (…/download?id=7). */
    if (/not a web page \(video\//i.test(page.error)) {
      const title = titleFromFileUrl(url);
      return {
        items: [{
          title,
          sourceUrl: url,
          sourceKind: "file",
          thumbnail: "",
          description: "",
          durationSec: 0,
          tags: [],
          site: hostOf(url)
        }],
        site: hostOf(url),
        pageTitle: title,
        finalUrl: url
      };
    }
    if (embed) {
      return {
        items: [{
          title: titleFromWatchUrl(url) || hostOf(url),
          sourceUrl: embed.sourceUrl,
          sourceKind: embed.kind,
          thumbnail: "",
          description: "",
          durationSec: 0,
          tags: [],
          site: hostOf(url)
        }],
        site: hostOf(url),
        pageTitle: titleFromWatchUrl(url),
        finalUrl: url
      };
    }
    return { error: page.error };
  }

  const finalUrl = page.finalUrl || url;
  const parsed = scrapePage(page.html, finalUrl);

  /* Recover duration and poster even when the player is lazy-loaded rather
     than declared in Open Graph metadata. */
  const pageDuration = extractDurationSeconds(page.html);
  if (pageDuration > 0 && parsed.items.length === 1 && !parsed.items[0].durationSec) {
    parsed.items[0].durationSec = pageDuration;
  }
  if (parsed.items.length === 1 && !parsed.items[0].thumbnail) {
    parsed.items[0].thumbnail = firstPosterImageUrl(page.html, finalUrl);
  }

  const pageKey = normaliseUrl(finalUrl);
  const singlePage = parsed.items.length === 1;

  for (const item of parsed.items) {
    /* A wrapper URL that merely points at a known tube becomes the tube's own
       stable embed — one less indeterminate hop at play time. */
    if (item.sourceKind === "embed") {
      let canonical = knownEmbedFor(item.sourceUrl);
      if (!canonical) {
        let decoded = "";
        try {
          decoded = decodeURIComponent(item.sourceUrl);
        } catch (error) {
          decoded = "";
        }
        if (decoded && decoded !== item.sourceUrl) canonical = knownEmbedFor(decoded);
      }
      if (canonical && canonical.sourceUrl !== item.sourceUrl) item.sourceUrl = canonical.sourceUrl;
      continue;
    }

    if (item.sourceKind !== "page" || normaliseUrl(item.sourceUrl) !== pageKey) continue;

    if (embed) {
      item.sourceUrl = embed.sourceUrl;
      item.sourceKind = embed.kind;
      continue;
    }
    if (!singlePage) continue;

    const fileUrl = firstMediaFileUrl(page.html, finalUrl);
    if (fileUrl) {
      item.sourceUrl = fileUrl;
      item.sourceKind = "file";
      continue;
    }
    const fromFrame = firstKnownFrameEmbed(page.html, finalUrl);
    if (fromFrame) {
      item.sourceUrl = fromFrame.sourceUrl;
      item.sourceKind = fromFrame.kind;
    }
  }

  /* WordPress salvage: the REST API often still has the file URL and poster
     when the page served to bots is obfuscated. */
  const single = parsed.items.length === 1 ? parsed.items[0] : null;
  if (single && WP_HINT.test(page.html) &&
      (single.sourceKind === "page" || !single.thumbnail || !single.durationSec)) {
    const rest = await wpRestRescue(finalUrl);
    if (rest) {
      if (single.sourceKind === "page" && rest.fileUrl) {
        single.sourceUrl = rest.fileUrl;
        single.sourceKind = "file";
      } else if (single.sourceKind === "page" && rest.playerUrl) {
        single.sourceUrl = rest.playerUrl;
        single.sourceKind = "embed";
      }
      if (rest.thumb) single.thumbnail = rest.thumb;
      if (!single.durationSec && rest.durationSec) single.durationSec = rest.durationSec;
      /* The REST title is the headline the blog actually wrote, so it also
         replaces a suspiciously short title (brands, "Watch", "Video"). */
      if (rest.title && (isBrandOnly(single.title, single.site, hostOf(finalUrl)) || single.title.length <= 12)) {
        single.title = rest.title;
      }
    }
  }

  /* Still nothing playable? Chase one player iframe. */
  if (single && single.sourceKind === "page") {
    const chased = await chaseIframePlayer(page.html, finalUrl);
    if (chased) {
      single.sourceUrl = chased.sourceUrl;
      single.sourceKind = chased.sourceKind;
      if (chased.thumbnail && !single.thumbnail) single.thumbnail = chased.thumbnail;
    }
  }

  /* Absolutise posters and drop anything that is not a real image link. */
  for (const item of parsed.items) {
    if (!item.thumbnail) continue;
    try {
      item.thumbnail = new URL(decodeEntities(item.thumbnail), finalUrl).toString();
    } catch (error) {
      item.thumbnail = "";
    }
  }

  return { ...parsed, finalUrl };
}
