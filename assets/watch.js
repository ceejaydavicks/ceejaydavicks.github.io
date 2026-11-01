/* ============================================================================
   THE WATCH PAGE — /watch?v=<id>
   ----------------------------------------------------------------------------
   A video of its own: its own address, its own title and meta tags, its own
   player and a "More like this" list that keeps loading while the visitor
   scrolls. The page is a static file, so a refresh or a pasted link works on
   Cloudflare Pages exactly like any other page.
   ========================================================================== */

const $ = (selector, root = document) => root.querySelector(selector);

const esc = (value) =>
  String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));

const clean = (value) => (typeof value === "string" ? value.trim() : "");

const safeUrl = (value) => {
  const candidate = clean(value);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate, window.location.href);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (error) {
    return "";
  }
};

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
};

const plural = (count) => (count === 1 ? "" : "s");

const tone = (index) =>
  ["244, 63, 94", "225, 29, 72", "251, 113, 133", "190, 18, 60", "253, 164, 175"][index % 5];

const ICONS = {
  play: '<path d="M7 4.8c0-.7.8-1.1 1.4-.7l11 7.2a.9.9 0 0 1 0 1.4l-11 7.2c-.6.4-1.4 0-1.4-.7V4.8Z"/>',
  bookmark: '<path d="M6.5 4.5h11a1 1 0 0 1 1 1v14l-6.5-4-6.5 4v-14a1 1 0 0 1 1-1Z"/>',
  share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.7 7.4-4.2M8.3 13.3l7.4 4.2"/>',
  telegram: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'
};

const svg = (name, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ""}</svg>`;

/* ---- configuration ------------------------------------------------------ */

let SITE_NAME = "BootyMansion";
let TELEGRAM_URL = "";

/* The same ad configuration the home page uses. At most one slot is mounted
   on this page, and it never sits next to the player. */
const AD_CONFIG = {
  banner: { label: "Advertisement", code: "" },
  native: { label: "Advertisement", every: 8, code: "" },
  smartlink: { label: "Sponsored", url: "", code: "" }
};

const API_TIMEOUT = 7000;
const RELATED_PAGE = 12;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---- the catalogue ------------------------------------------------------ */

function splitTags(value) {
  const list = Array.isArray(value) ? value : String(value == null ? "" : value).split(",");
  return list.map((tag) => clean(tag)).filter(Boolean);
}

function postedLabel(value) {
  if (!value) return "";
  const raw = String(value);
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "";

  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/* A row of /api/videos becomes a video of the site. */
function rowToVideo(row) {
  if (!row || typeof row !== "object") return null;

  const embedUrl = clean(row.embed_url);
  const videoUrl = clean(row.video_url);
  const title = clean(row.title);
  if (!title) return null;

  let directUrl = "";
  try {
    const parsed = new URL(videoUrl, window.location.href);
    if (["http:", "https:"].includes(parsed.protocol)) directUrl = parsed.href;
  } catch (error) {
    directUrl = "";
  }

  const durationSeconds = window.VideoRules.seconds(row.duration_seconds) || window.VideoRules.seconds(row.duration);

  return {
    id: row.id != null ? `a${row.id}` : null,
    title,
    creator: clean(row.creator),
    views: clean(row.views),
    duration: clean(row.duration) || formatDuration(durationSeconds),
    durationSeconds,
    tag: clean(row.tag),
    tags: splitTags(row.tags).length ? splitTags(row.tags) : splitTags(row.tag),
    category: clean(row.tag),
    caption: clean(row.caption),
    description: clean(row.caption),
    thumb: safeUrl(row.thumbnail_url),
    url: directUrl,
    directUrl,
    embed: /^https?:\/\//i.test(embedUrl) ? embedUrl : null,
    embedUrl,
    orientation: row.orientation === "vertical" ? "vertical" : "horizontal",
    posted: postedLabel(row.created_at),
    createdAt: clean(row.created_at),
    ratio: 0
  };
}

const isShort = (video) => window.VideoRules.isShort(video.durationSeconds);

/* How old a video is, so the newest ones come first when nothing else tells
   them apart. */
function publishedAt(video) {
  const raw = String(video.createdAt || "").trim();
  if (raw) {
    const stamp = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
    if (!Number.isNaN(stamp)) return stamp;
  }
  return 0;
}

/* ---- data --------------------------------------------------------------- */

const [videosResult, settingsResult] = await Promise.allSettled([
  fetchJson("/api/videos"),
  fetchJson("/api/settings")
]);

if (settingsResult.status === "fulfilled") {
  const settings = (settingsResult.value && settingsResult.value.settings) || {};
  const siteName = clean(settings.siteName);
  if (siteName) SITE_NAME = siteName.slice(0, 60);
  const telegram = clean(settings.telegramUrl);
  if (/^https?:\/\//i.test(telegram)) TELEGRAM_URL = telegram;
  AD_CONFIG.banner.code = typeof settings.adBannerCode === "string" ? settings.adBannerCode.trim() : "";
  AD_CONFIG.native.code = typeof settings.adNativeCode === "string" ? settings.adNativeCode.trim() : "";
  AD_CONFIG.smartlink.code =
    typeof settings.adSmartlinkCode === "string" ? settings.adSmartlinkCode.trim() : "";
  if (/^https?:\/\//i.test(clean(settings.adSmartlinkUrl))) AD_CONFIG.smartlink.url = clean(settings.adSmartlinkUrl);
}

const rows = videosResult.status === "fulfilled" ? (videosResult.value || {}).videos : [];
const VIDEOS = (Array.isArray(rows) ? rows : []).map(rowToVideo).filter(Boolean);

/* ---- the video that was asked for --------------------------------------- */

const requested = clean(new URLSearchParams(window.location.search).get("v"));
const current =
  VIDEOS.find((video) => video.id === `a${requested}`) ||
  VIDEOS.find((video) => String(video.id) === requested) ||
  null;

/* ---- page title and meta tags ------------------------------------------ */

function setMeta(selector, attribute, value) {
  const node = $(selector);
  if (!node) return;
  if (value) node.setAttribute(attribute, value);
  else node.removeAttribute(attribute);
}

function applyHead(video) {
  if (!video) {
    document.title = `Watch · ${SITE_NAME}`;
    setMeta("#meta-description", "content", "");
    setMeta("#og-title", "content", "");
    setMeta("#og-description", "content", "");
    setMeta("#og-image", "content", "");
    return;
  }

  const title = `${video.title} · ${SITE_NAME}`;
  document.title = title;

  const description =
    clean(video.caption) ||
    [video.creator, video.duration, video.views ? `${video.views} views` : ""]
      .filter(Boolean)
      .join(" · ") ||
    `Watch ${video.title} on ${SITE_NAME}.`;

  setMeta("#meta-description", "content", description.slice(0, 300));
  setMeta("#og-title", "content", title);
  setMeta("#og-description", "content", description.slice(0, 300));
  setMeta("#og-image", "content", video.thumb || "");

  const canonical = $("#canonical");
  if (canonical) canonical.setAttribute("href", `${window.location.origin}/watch?v=${requested}`);
}

/* ---- the player --------------------------------------------------------- */

function playerBackdrop(video) {
  if (!video || !video.thumb) return null;
  const blur = document.createElement("img");
  blur.className = "video-frame__blur";
  blur.src = video.thumb;
  blur.alt = "";
  blur.decoding = "async";
  blur.setAttribute("aria-hidden", "true");
  return blur;
}

function makeFallback(video) {
  const fallback = document.createElement("div");
  fallback.className = "player-empty";
  fallback.innerHTML = `<strong>This video cannot play here.</strong>`;

  if (video && video.url) {
    const link = document.createElement("a");
    link.href = video.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open the original video";
    fallback.append(link);
  }

  return fallback;
}

function renderPlayer(video) {
  const frame = $("#watch-player");
  if (!frame || !video) return;

  /* The frame keeps the wide shape of the site: a wide video fills it, and a
     vertical one keeps its own ratio in the middle while the blurred poster
     fills the sides — no black bars. */
  frame.style.setProperty("--watch-ar", "16 / 9");

  const backdrop = playerBackdrop(video);
  frame.replaceChildren();

  if (video.embedUrl) {
    const iframe = document.createElement("iframe");
    const embed = new URL(video.embedUrl);
    embed.searchParams.set("autoplay", "1");
    embed.searchParams.set("muted", "1");
    iframe.src = embed.href;
    iframe.title = `${video.title} video`;
    iframe.loading = "eager";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    iframe.setAttribute("allowfullscreen", "");
    frame.append(...(backdrop ? [backdrop] : []), iframe);
    return;
  }

  if (!video.directUrl) {
    frame.append(...(backdrop ? [backdrop] : []), makeFallback(video));
    return;
  }

  const media = document.createElement("video");
  media.controls = true;
  media.playsInline = true;
  media.preload = "metadata";
  media.autoplay = true;
  media.muted = true;
  media.setAttribute("aria-label", `${video.title} video`);
  if (video.thumb) media.poster = video.thumb;

  /* The big play button: it is there when autoplay is blocked, and it is
     always the way to start the video with a single tap. */
  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "watch__play";
  playButton.setAttribute("aria-label", `Play ${video.title}`);
  playButton.innerHTML = svg("play", "icon icon--fill");

  const start = () => {
    const started = media.play();
    if (started && typeof started.catch === "function") started.catch(() => {});
    frame.classList.add("is-playing");
  };

  playButton.addEventListener("click", start);
  media.addEventListener("play", () => frame.classList.add("is-playing"));
  media.addEventListener("error", () => {
    if (frame.contains(media)) frame.replaceChildren(...(backdrop ? [backdrop] : []), makeFallback(video));
  });

  frame.append(...(backdrop ? [backdrop] : []), media, playButton);
  media.src = video.directUrl;

  const started = media.play();
  if (started && typeof started.catch === "function") {
    started.then(() => frame.classList.add("is-playing")).catch(() => frame.classList.remove("is-playing"));
  }
}

/* ---- the details under the player --------------------------------------- */

function renderInfo(video) {
  const title = $("#watch-title");
  const caption = $("#watch-caption");
  const meta = $("#watch-meta");

  if (!video) return;

  title.textContent = video.title;

  if (video.caption) {
    caption.textContent = video.caption;
    caption.hidden = false;
  } else {
    caption.hidden = true;
  }

  const bits = [];
  if (video.creator) bits.push(`<span>${esc(video.creator)}</span>`);
  if (video.views) bits.push(`<span>${esc(video.views)} views</span>`);
  if (video.duration) bits.push(`<span>${esc(video.duration)}</span>`);
  if (video.posted) bits.push(`<span>${esc(video.posted)}</span>`);
  if (isShort(video)) bits.push(`<span class="watch__short">Short</span>`);
  meta.innerHTML = bits.join('<span class="watch__dot" aria-hidden="true">·</span>');

}

/* ---- share, save, telegram ---------------------------------------------- */

const SAVED_KEY = `saved:${SITE_NAME}`;

function savedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"));
  } catch (error) {
    return new Set();
  }
}

function syncSaveButton(saved) {
  const button = $("#watch-save");
  if (!button) return;
  button.classList.toggle("is-on", saved);
  button.setAttribute("aria-pressed", String(saved));
  const label = button.querySelector("span:last-child");
  if (label) label.textContent = saved ? "Saved" : "Save";
}

function toggleSave() {
  if (!current) return;
  const saved = savedSet();
  const nowSaved = !saved.has(current.id);
  if (nowSaved) saved.add(current.id);
  else saved.delete(current.id);
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
  } catch (error) {
    /* Private mode: saving is skipped silently. */
  }
  syncSaveButton(nowSaved);
}

async function shareCurrent() {
  if (!current) return;
  const url = window.location.href;
  const payload = { title: current.title, text: `${current.title} · ${SITE_NAME}`, url };

  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (error) {
      /* The visitor dismissed the sheet — fall through to copying. */
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    const note = $("#watch-note");
    if (note) {
      note.textContent = "Link copied";
      note.classList.add("is-visible");
      window.setTimeout(() => note.classList.remove("is-visible"), 2200);
    }
  } catch (error) {
    /* Nothing else to try — the address bar has the link. */
  }
}

function setupActions() {
  const save = $("#watch-save");
  if (save) save.addEventListener("click", toggleSave);

  const share = $("#watch-share");
  if (share) share.addEventListener("click", shareCurrent);

  const telegram = $("#watch-telegram");
  if (telegram) {
    if (/^https?:\/\//i.test(TELEGRAM_URL)) {
      telegram.href = TELEGRAM_URL;
      telegram.target = "_blank";
      telegram.rel = "noopener noreferrer";
    } else {
      telegram.hidden = true;
    }
  }
}

/* ---- the related list --------------------------------------------------- */

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "video", "clip", "this", "that", "from", "your", "you",
  "are", "was", "here", "have", "will", "not", "but", "all", "can", "her", "his", "she",
  "him", "they", "them", "its", "out", "into", "over", "when", "what", "some", "more",
  "telegram", "instagram", "http", "https", "www", "com"
]);

function keywordSet(video) {
  const text = `${video.title} ${video.caption || ""} ${video.description || ""}`.toLowerCase();
  const words = text.split(/[^a-z0-9']+/).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return new Set(words);
}

/* How close two videos are: shared tags first, then the words they share,
   then a similar length or the same shape, and finally the newest one. */
function rankRelated(video, current, currentTags, currentWords) {
  const tags = (video.tags || []).map((tag) => tag.toLowerCase());
  let shared = 0;
  currentTags.forEach((tag) => {
    if (tags.includes(tag)) shared += 1;
  });

  const words = keywordSet(video);
  let keywords = 0;
  currentWords.forEach((word) => {
    if (words.has(word)) keywords += 1;
  });

  let close = 0;
  const here = Number(current.durationSeconds) || 0;
  const there = Number(video.durationSeconds) || 0;
  if (here > 0 && there > 0) {
    close = Math.max(0, 1 - Math.abs(here - there) / Math.max(here, there));
  }

  return { video, shared, keywords, close, at: publishedAt(video) };
}

function relatedVideos(video) {
  const currentTags = new Set((video.tags || []).map((tag) => tag.toLowerCase()));
  const currentWords = keywordSet(video);

  return VIDEOS.filter((item) => item.id !== video.id)
    .map((item) => rankRelated(item, video, currentTags, currentWords))
    .sort((a, b) => {
      if (b.shared !== a.shared) return b.shared - a.shared;
      if (b.keywords !== a.keywords) return b.keywords - a.keywords;
      if (b.close !== a.close) return b.close - a.close;
      return b.at - a.at;
    })
    .map((entry) => entry.video);
}

/* ---- the cards ---------------------------------------------------------- */

function watchUrl(video) {
  const key = String(video.id || "").replace(/^a/, "");
  return `/watch?v=${encodeURIComponent(key)}`;
}

function cardMetaText(video) {
  return [video.creator, video.views ? `${video.views} views` : "", video.posted]
    .filter(Boolean)
    .join(" · ");
}

function createCard(video, index) {
  const card = document.createElement("article");
  card.className = "media-card masonry-card";

  const poster = document.createElement("div");
  poster.className = "poster poster--masonry";
  poster.style.setProperty("--tone", tone(index));
  poster.style.setProperty("--ar", String(video.ratio || (isShort(video) ? 9 / 16 : 16 / 9)));

  const button = document.createElement("a");
  button.className = "poster__btn";
  button.href = watchUrl(video);
  button.setAttribute("aria-label", `Watch ${video.title}`);
  button.innerHTML = [
    '<span class="poster__art" aria-hidden="true"></span>',
    '<span class="poster__shade" aria-hidden="true"></span>',
    isShort(video) ? '<span class="poster__short">Short</span>' : "",
    `<span class="poster__dur" ${video.duration ? "" : "hidden"}>${esc(video.duration || "")}</span>`,
    `<span class="poster__play" aria-hidden="true">${svg("play", "icon icon--fill")}</span>`
  ].join("");
  poster.append(button);

  if (video.thumb) {
    const image = document.createElement("img");
    image.className = "poster__media";
    image.alt = "";
    image.decoding = "async";
    image.loading = "lazy";
    image.src = video.thumb;
    image.addEventListener(
      "load",
      () => {
        applyNaturalRatio(poster, video, image.naturalWidth, image.naturalHeight);
        poster.classList.add("has-media");
      },
      { once: true }
    );
    image.addEventListener("error", () => image.remove(), { once: true });
    poster.append(image);
  } else if (video.directUrl) {
    /* No picture of its own: the first frame of the file stands in. */
    const frame = document.createElement("video");
    frame.className = "poster__media";
    frame.muted = true;
    frame.defaultMuted = true;
    frame.playsInline = true;
    frame.preload = "metadata";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.src = `${video.directUrl}#t=1`;
    frame.addEventListener(
      "loadeddata",
      () => {
        poster.classList.add("has-media");
        applyNaturalRatio(poster, video, frame.videoWidth, frame.videoHeight);
      },
      { once: true }
    );
    frame.addEventListener("error", () => frame.remove(), { once: true });
    poster.append(frame);
  }

  const body = document.createElement("div");
  body.className = "card__body";
  body.innerHTML = [
    '<div class="card__text">',
    `<h3 class="card__title"><a href="${esc(watchUrl(video))}">${esc(video.title)}</a></h3>`,
    cardMetaText(video) ? `<p class="card__meta">${esc(cardMetaText(video))}</p>` : "",
    "</div>"
  ].join("");

  card.append(poster, body);
  return card;
}

/* ---- masonry ------------------------------------------------------------ */

const masonryMobile = window.matchMedia("(max-width: 767px)");

function masonryColumnCount() {
  return masonryMobile.matches ? 3 : 2;
}

function masonryGap(grid) {
  const value = parseFloat(getComputedStyle(grid).columnGap);
  return Number.isFinite(value) ? value : 20;
}

function estimatedCardHeight(card, columnWidth) {
  const poster = card.querySelector(".poster");
  const known = parseFloat(poster && poster.style.getPropertyValue("--ar"));
  const ratio = Number.isFinite(known) && known > 0 ? known : 16 / 9;
  return columnWidth / ratio + 66;
}

/* Items drop into whichever column is shortest, so the grid has no holes. */
function distributeMasonry(grid) {
  const cards = grid._masonryCards;
  if (!cards || !cards.length) return;

  const cols = masonryColumnCount();
  const gap = masonryGap(grid);
  const width = grid.clientWidth;
  const columnWidth = width ? Math.max(80, (width - gap * (cols - 1)) / cols) : 460;

  grid.replaceChildren();

  const columns = [];
  const estimated = [];
  for (let i = 0; i < cols; i += 1) {
    const column = document.createElement("div");
    column.className = "masonry__col";
    grid.append(column);
    columns.push(column);
    estimated.push(0);
  }

  const measurable = width > 0 && grid.offsetParent !== null;

  cards.forEach((card) => {
    let target = 0;
    for (let i = 1; i < cols; i += 1) {
      const current = measurable ? columns[target].offsetHeight : estimated[target];
      const candidate = measurable ? columns[i].offsetHeight : estimated[i];
      if (candidate < current) target = i;
    }
    columns[target].append(card);
    estimated[target] += estimatedCardHeight(card, columnWidth) + gap;
  });

  grid.dataset.masonryCols = String(cols);
}

let masonryTimer = 0;

function scheduleMasonryReflow() {
  window.clearTimeout(masonryTimer);
  masonryTimer = window.setTimeout(() => {
    const grid = $("#related-grid");
    if (grid) distributeMasonry(grid);
  }, 120);
}

window.addEventListener("resize", scheduleMasonryReflow);

/* The video's own shape drives the card, so nothing is cropped. */
function applyNaturalRatio(posterNode, video, width, height) {
  if (!posterNode || !width || !height) return;
  const ratio = width / height;
  if (!Number.isFinite(ratio) || ratio <= 0) return;

  const rounded = Number(ratio.toFixed(4));
  if (video) video.ratio = rounded;
  posterNode.style.setProperty("--ar", String(rounded));
  scheduleMasonryReflow();
}

/* ---- the list itself ---------------------------------------------------- */

const SEEN_KEY = "bootymansion:watch-session-seen";
const sessionSeen = (() => {
  try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || "[]")); }
  catch (_) { return new Set(); }
})();

function rememberSeen(id) {
  if (!id) return;
  sessionSeen.add(String(id));
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...sessionSeen])); }
  catch (_) { /* Session storage can be unavailable in private browsing. */ }
}

let relatedItems = [];
let relatedShown = 0;
let fallbackCursor = 0;
const shownOnThisPage = new Set();

function newestOtherVideos() {
  return VIDEOS.filter((video) => video.id !== (current && current.id))
    .slice()
    .sort((a, b) => publishedAt(b) - publishedAt(a));
}

function nextEndlessChunk() {
  const newest = newestOtherVideos();
  const unseen = newest.filter((video) => !sessionSeen.has(video.id) && !shownOnThisPage.has(video.id));
  if (unseen.length) return unseen.slice(0, RELATED_PAGE);

  /* Nothing unseen remains in this browser session. Keep the page alive by
     looping through the newest other videos, never including the current one. */
  if (!newest.length) return [];
  const chunk = [];
  for (let i = 0; i < RELATED_PAGE; i += 1) {
    chunk.push(newest[(fallbackCursor + i) % newest.length]);
  }
  fallbackCursor = (fallbackCursor + chunk.length) % newest.length;
  return chunk;
}

function renderRelatedChunk() {
  const grid = $("#related-grid");
  if (!grid) return;

  let chunk = relatedItems.slice(relatedShown, relatedShown + RELATED_PAGE);
  if (!chunk.length) chunk = nextEndlessChunk();
  if (!chunk.length) return; // Only possible when the catalogue has no other video.

  const cards = grid._masonryCards || [];
  chunk.forEach((video, index) => {
    cards.push(createCard(video, cards.length + index));
    shownOnThisPage.add(video.id);
    rememberSeen(video.id);
  });

  grid._masonryCards = cards;
  relatedShown += chunk.length;
  distributeMasonry(grid);

}

function setupInfiniteScroll() {
  const sentinel = $("#related-sentinel");
  if (!sentinel) return;
  if (!("IntersectionObserver" in window)) {
    window.addEventListener("scroll", () => {
      if (sentinel.getBoundingClientRect().top < window.innerHeight + 400) renderRelatedChunk();
    }, { passive: true });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        renderRelatedChunk();
      });
    },
    { rootMargin: "400px 0px" }
  );

  observer.observe(sentinel);
}

/* ---- the one ad slot ---------------------------------------------------- */

function mountAd() {
  const container = $("#watch-ad");
  if (!container) return;

  const slot = AD_CONFIG.banner || {};
  const code = typeof slot.code === "string" ? slot.code.trim() : "";
  if (!code) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }

  const label = document.createElement("span");
  label.className = "ad-slot__label";
  label.textContent = slot.label || "Advertisement";

  const frame = document.createElement("div");
  frame.className = "ad-slot__frame";
  frame.innerHTML = code;

  container.replaceChildren(label, frame);
  container.hidden = false;

  /* Scripts inserted with innerHTML never run — they are created again here. */
  frame.querySelectorAll("script").forEach((stale) => {
    const script = document.createElement("script");
    for (const attribute of stale.attributes) script.setAttribute(attribute.name, attribute.value);
    script.textContent = stale.textContent;
    stale.replaceWith(script);
  });
}

/* ---- start -------------------------------------------------------------- */

function renderNotFound() {
  const title = $("#watch-title");
  const caption = $("#watch-caption");
  if (title) title.textContent = "This video is not available";
  if (caption) {
    caption.hidden = false;
    caption.textContent = "It may have been removed from the library.";
  }
  const frame = $("#watch-player");
  if (frame) frame.hidden = true;
  const related = $("#related-section");
  if (related) related.hidden = true;
}

applyHead(current);

if (current) {
  rememberSeen(current.id);
  renderPlayer(current);
  renderInfo(current);
  setupActions();
  syncSaveButton(savedSet().has(current.id));

  // The first screen is the top twelve ranked by tags, title/caption words,
  // duration similarity and recency. Later chunks then continue newest-first.
  relatedItems = relatedVideos(current).slice(0, RELATED_PAGE);
  renderRelatedChunk();
  setupInfiniteScroll();
} else {
  renderNotFound();
}

mountAd();
scheduleMasonryReflow();
