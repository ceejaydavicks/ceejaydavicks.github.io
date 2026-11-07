/* ============================================================================
   Shared catalogue loader — one request path for the header, home and watch.
   ----------------------------------------------------------------------------
   Loaded once per page as a classic (defer) script so both the shared nav and
   the page's own module can use it. It provides:

   - a single in-flight promise: the home page, watch page and shared nav no
     longer each fetch /api/videos and /api/settings separately
   - an 8s per-attempt timeout with up to 3 attempts and a short backoff
   - 24-row pages fetched in parallel, deduped by id (a stale edge-cache page
     can never produce a duplicate card)
   - a short sessionStorage cache so moving to the watch page paints instantly
   - a public detail endpoint for the playable URL, prefetchable on card hover

   All responses rely on the edge Cache-Control header; the browser shuffle
   still happens locally, so a cached list is safe to share between visitors.
   ========================================================================== */
(function () {
  "use strict";

  var TIMEOUT_MS = 8000;
  var ATTEMPTS = 3;
  var BACKOFF_MS = [200, 600];
  var PAGE_SIZE = 24;
  var MAX_PAGES = 40;
  var TTL_MS = 60000;

  var CACHE_KEY = "bootymansion.catalogue.v4";
  var SETTINGS_KEY = "bootymansion.settings.v4";
  var DETAIL_PREFIX = "bootymansion.detail.";

  var catalogueInflight = null;
  var settingsInflight = null;
  var details = new Map();
  var warmedHosts = new Set();

  /* Most posters live on one other origin (the bot's Worker). A single
     preconnect removes a DNS + TLS round trip from EVERY card image, which is
     by far the slowest part of a cold page load. Purely an optimisation. */
  function warmThumbnailHosts(rows) {
    try {
      for (var i = 0; i < rows.length && warmedHosts.size < 2; i += 1) {
        var raw = rows[i] && rows[i].thumbnail_url;
        if (!raw || !/^https?:\/\//i.test(raw)) continue;
        var parsed = new URL(raw, window.location.href);
        if (parsed.origin === window.location.origin || warmedHosts.has(parsed.origin)) continue;
        warmedHosts.add(parsed.origin);
        var link = document.createElement("link");
        link.rel = "preconnect";
        link.href = parsed.origin;
        document.head.appendChild(link);
      }
    } catch (error) { /* an optimisation must never break the feed */ }
  }

  function delay(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function readCache(key) {
    try {
      var raw = window.sessionStorage.getItem(key);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > TTL_MS) return null;
      return entry.value;
    } catch (error) {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value: value }));
    } catch (error) {
      /* Private mode / storage full: the in-memory promise still dedupes. */
    }
  }

  /* One GET, retried on network errors, 5xx, bad JSON or an 8s timeout.
     4xx is retried too — a transient edge error often looks like one. */
  async function fetchJson(url) {
    var lastError = null;
    for (var attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      var controller = new AbortController();
      var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      try {
        var response = await window.fetch(url, {
          headers: { accept: "application/json" },
          credentials: "same-origin",
          cache: "default",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(url + " responded " + response.status);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS - 1) await delay(BACKOFF_MS[attempt] || 600);
      } finally {
        window.clearTimeout(timer);
      }
    }
    throw lastError || new Error("Request failed");
  }

  function pageUrl(offset) {
    return "/api/videos?limit=" + PAGE_SIZE + "&offset=" + offset;
  }

  async function loadCatalogue() {
    var cached = readCache(CACHE_KEY);
    if (cached && Array.isArray(cached.videos)) {
      warmThumbnailHosts(cached.videos);
      return cached;
    }

    var first = await fetchJson(pageUrl(0));
    var rows = Array.isArray(first && first.videos) ? first.videos.slice() : [];
    var total = Number(first && first.total) || rows.length;
    var limit = Number(first && first.limit) || PAGE_SIZE;

    /* The browser shuffle needs the whole catalogue, but each response is at
       most 24 lean rows. The rest arrive in parallel, so total latency stays
       close to one request while the payload is split into cacheable pages. */
    if (first && first.hasMore && total > rows.length) {
      var offsets = [];
      for (var offset = limit; offset < total && offsets.length < MAX_PAGES; offset += limit) {
        offsets.push(offset);
      }
      var results = await Promise.allSettled(offsets.map(function (o) { return fetchJson(pageUrl(o)); }));
      results.forEach(function (result) {
        if (result.status === "fulfilled" && Array.isArray(result.value && result.value.videos)) {
          rows = rows.concat(result.value.videos);
        }
      });
    }

    var seen = new Set();
    rows = rows.filter(function (row) {
      if (!row || row.id == null) return false;
      var key = String(row.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    warmThumbnailHosts(rows);

    var value = { videos: rows, total: total, partial: rows.length < total };
    writeCache(CACHE_KEY, value);
    return value;
  }

  function load() {
    if (!catalogueInflight) {
      catalogueInflight = loadCatalogue().catch(function (error) {
        catalogueInflight = null;
        throw error;
      });
    }
    return catalogueInflight;
  }

  /* Settings are decorative; a failure must never blank the page. */
  function settings() {
    var cached = readCache(SETTINGS_KEY);
    if (cached) return Promise.resolve(cached);
    if (!settingsInflight) {
      settingsInflight = fetchJson("/api/settings")
        .then(function (payload) {
          var value = (payload && payload.settings) || {};
          writeCache(SETTINGS_KEY, value);
          return value;
        })
        .catch(function () {
          settingsInflight = null;
          return {};
        });
    }
    return settingsInflight;
  }

  function normaliseId(id) {
    return String(id == null ? "" : id).replace(/^a/, "");
  }

  function detail(id) {
    var key = normaliseId(id);
    if (!key) return Promise.resolve(null);
    if (details.has(key)) return details.get(key);
    var promise = fetchJson("/api/videos/" + encodeURIComponent(key))
      .then(function (payload) { return (payload && payload.video) || null; })
      .catch(function () { details.delete(key); return null; });
    details.set(key, promise);
    return promise;
  }

  /* Read a prefetched detail synchronously on the watch page, so the player
     can be built before the network round trip finishes. */
  function cachedDetail(id) {
    var key = normaliseId(id);
    if (!key) return null;
    try {
      var raw = window.sessionStorage.getItem(DETAIL_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  var prefetchedHtml = new Set();

  /* Called when a card is hovered, focused, tapped or scrolled into view.
     Both the JSON detail and the watch HTML are warmed; failures are ignored. */
  function prefetch(id) {
    var key = normaliseId(id);
    if (!key) return;
    detail(key).then(function (video) {
      if (!video) return;
      try {
        window.sessionStorage.setItem(DETAIL_PREFIX + key, JSON.stringify(video));
      } catch (error) { /* storage full */ }
    });
    if (!prefetchedHtml.has(key)) {
      prefetchedHtml.add(key);
      try {
        var link = document.createElement("link");
        link.rel = "prefetch";
        link.href = "/watch/?v=" + encodeURIComponent(key);
        document.head.appendChild(link);
      } catch (error) { /* prefetch is an optimisation only */ }
    }
  }

  function clear() {
    catalogueInflight = null;
    settingsInflight = null;
    details.clear();
    try {
      window.sessionStorage.removeItem(CACHE_KEY);
      window.sessionStorage.removeItem(SETTINGS_KEY);
    } catch (error) { /* private mode */ }
  }

  window.Catalogue = {
    load: load,
    settings: settings,
    detail: detail,
    cachedDetail: cachedDetail,
    prefetch: prefetch,
    clear: clear,
    pageSize: PAGE_SIZE,
    timeout: TIMEOUT_MS,
    attempts: ATTEMPTS
  };
})();
