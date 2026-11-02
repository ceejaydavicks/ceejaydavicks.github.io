/* ============================================================================
   SHARED HEADER + NAVIGATION DRAWER
   ----------------------------------------------------------------------------
   One component for every public page. A page only needs two things:

     <script src="/assets/site-nav.js" defer></script>
     <div id="site-nav-root" [data-nav-extras="home"]></div>

   The root is replaced with the header, the overlay and the drawer, so the
   hamburger and the drawer can never be missing from a page. Home opts into
   its extra header controls (search, theme, Telegram) with
   data-nav-extras="home"; every other page gets just the hamburger followed
   by the home-linked logo.

   Home supplies the category list once its catalogue has loaded via
   window.SiteNav.setCategories([...]). Other pages get the list from the
   public catalogue API (with the bundled samples as a static fallback).
   ========================================================================== */
(function () {
  "use strict";

  const root = document.getElementById("site-nav-root");
  if (!root) return;

  const homeExtras = root.dataset.navExtras === "home";

  /* Home-only header controls. Kept here so every page shares one header. */
  const extras = homeExtras ? `
      <label class="search search--desktop" for="search-input">
        <span class="search__icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.6-3.6"></path></svg></span>
        <input id="search-input" type="search" placeholder="Search videos…" autocomplete="off" spellcheck="false" aria-label="Search videos">
      </label>
      <button class="icon-btn search-toggle" type="button" aria-label="Open search" aria-expanded="false" aria-controls="search-mobile">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.6-3.6"></path></svg>
      </button>
      <button class="icon-btn theme-toggle" type="button" data-theme-toggle aria-label="Switch to light mode" title="Switch to light mode">
        <svg class="icon theme-icon theme-icon--sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l1.6 1.6"></path></svg>
        <svg class="icon theme-icon theme-icon--moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 14.4A8.6 8.6 0 0 1 9.6 3.4a8.6 8.6 0 1 0 11 11Z"></path></svg>
      </button>
      <a class="btn btn-telegram-nav btn-telegram-icon" data-telegram href="#telegram" aria-label="Open Telegram" title="Telegram">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>
      </a>` : "";

  const mobileSearch = homeExtras ? `
    <div class="shell search-mobile" id="search-mobile" hidden>
      <label class="search" for="search-input-mobile">
        <span class="search__icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.6-3.6"></path></svg></span>
        <input id="search-input-mobile" type="search" placeholder="Search videos…" autocomplete="off" spellcheck="false" aria-label="Search videos">
      </label>
    </div>` : "";

  const markup = `
<header class="site-header">
  <div class="shell nav-shell">
    <button class="icon-btn menu-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="site-drawer">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
    </button>
    <a class="brand" href="/" aria-label="BootyMansion home">
      <span class="brand-logo" role="img" aria-label="BootyMansion"></span>
    </a>${extras}
  </div>${mobileSearch}
</header>

<div class="drawer-overlay" id="drawer-overlay"></div>
<aside class="nav-drawer" id="site-drawer" aria-label="Main menu" aria-hidden="true" inert>
  <div class="drawer-head">
    <a class="brand drawer-mark" href="/" aria-label="BootyMansion home"><img src="/assets/apple-touch-icon.png" alt="" width="34" height="34"></a>
    <button class="icon-btn drawer-close" type="button" aria-label="Close menu"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button>
  </div>
  <nav class="drawer-links" aria-label="Main navigation">
    <button class="drawer-categories-toggle" id="drawer-categories-toggle" type="button" aria-expanded="false" aria-controls="drawer-categories-panel" style="--icon-step: 0">
      <svg class="icon drawer-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"></rect></svg>
      <span class="drawer-label">Categories</span>
      <svg class="icon drawer-categories-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
    </button>
    <div class="drawer-categories-panel" id="drawer-categories-panel" aria-hidden="true" inert>
      <div class="drawer-categories-panel__inner">
        <label class="drawer-categories-search" for="drawer-categories-search-input">
          <span class="drawer-categories-search__icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.6-3.6"></path></svg></span>
          <input id="drawer-categories-search-input" type="search" placeholder="Search categories" autocomplete="off" spellcheck="false" aria-label="Search categories">
        </label>
        <div class="drawer-categories-list" id="drawer-categories" role="group" aria-label="Video categories"></div>
        <p class="drawer-categories-empty" id="drawer-categories-empty" hidden>No categories found</p>
      </div>
    </div>
    <a href="/" data-view-link="home" style="--icon-step: 1">
      <svg class="icon drawer-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1Z"></path></svg>
      <span class="drawer-label">Home</span>
    </a>
    <a href="/?view=shorts" data-view-link="shorts" style="--icon-step: 2">
      <svg class="icon drawer-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z"></path><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z"></path></svg>
      <span class="drawer-label">Shorts</span>
    </a>
    <a href="/?view=movies" data-view-link="movies" style="--icon-step: 3">
      <svg class="icon drawer-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"></rect><path d="M8 5v14M16 5v14"></path></svg>
      <span class="drawer-label">Movies</span>
    </a>
    <a href="/?view=library" data-view-link="library" style="--icon-step: 4">
      <svg class="icon drawer-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.5h9a2 2 0 0 1 2 2v11h-9a2 2 0 0 1-2-2Z"></path><path d="M15.5 8.5h3a1 1 0 0 1 1 1v9h-4Z"></path></svg>
      <span class="drawer-label">Library</span>
    </a>
  </nav>
  <a class="drawer-telegram" data-telegram href="#telegram" style="--icon-step: 5">
    <svg class="icon drawer-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>
    <span class="drawer-label">Telegram</span>
  </a>
</aside>`;

  const holder = document.createElement("div");
  holder.innerHTML = markup;
  const fragment = document.createDocumentFragment();
  while (holder.firstChild) fragment.appendChild(holder.firstChild);
  root.replaceWith(fragment);

  const toggle = document.querySelector(".menu-toggle");
  const drawer = document.getElementById("site-drawer");
  const overlay = document.getElementById("drawer-overlay");
  const closeButton = drawer.querySelector(".drawer-close");
  const categoriesToggle = document.getElementById("drawer-categories-toggle");
  const panel = document.getElementById("drawer-categories-panel");
  const searchInput = document.getElementById("drawer-categories-search-input");
  const list = document.getElementById("drawer-categories");
  const empty = document.getElementById("drawer-categories-empty");
  const telegramLink = drawer.querySelector("[data-telegram]");

  let categories = [];
  const collator = typeof Intl !== "undefined" && Intl.Collator
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
    : null;

  /* Numbers first (0-9), then A-Z. Numeric collation puts "4k" before "10k";
     "base" sensitivity makes the order case-insensitive. */
  function normalizeCategories(values) {
    const reserved = /^(all|shorts|movies)$/i;
    const unique = new Map();
    (Array.isArray(values) ? values : []).forEach((value) => {
      const raw = typeof value === "string" ? value.trim() : "";
      if (!raw || reserved.test(raw)) return;
      const key = raw.toLowerCase();
      if (unique.has(key)) return;
      unique.set(key, raw.charAt(0).toUpperCase() + raw.slice(1));
    });
    return [...unique.values()].sort((a, b) => {
      const aNumber = /^[0-9]/.test(a);
      const bNumber = /^[0-9]/.test(b);
      if (aNumber !== bNumber) return aNumber ? -1 : 1;
      if (collator) return collator.compare(a, b);
      return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
    });
  }

  function renderCategories() {
    const query = searchInput.value.trim().toLowerCase();
    const matches = categories.filter((label) => label.toLowerCase().includes(query));
    const items = document.createDocumentFragment();
    matches.forEach((label) => {
      const link = document.createElement("a");
      link.className = "drawer-category";
      link.href = "/?category=" + encodeURIComponent(label);
      link.dataset.navCategory = label;
      const text = document.createElement("span");
      text.className = "drawer-label";
      text.textContent = label;
      link.appendChild(text);
      items.appendChild(link);
    });
    list.replaceChildren(items);
    empty.hidden = matches.length > 0;
  }

  /* Closing (or reopening) always starts with Categories collapsed again. */
  function resetCategories() {
    categoriesToggle.setAttribute("aria-expanded", "false");
    panel.classList.remove("is-expanded");
    panel.setAttribute("aria-hidden", "true");
    panel.inert = true;
    searchInput.value = "";
  }

  function toggleCategories() {
    const expanded = categoriesToggle.getAttribute("aria-expanded") === "true";
    categoriesToggle.setAttribute("aria-expanded", String(!expanded));
    panel.classList.toggle("is-expanded", !expanded);
    panel.setAttribute("aria-hidden", String(expanded));
    panel.inert = expanded;
    if (!expanded) renderCategories();
  }

  function open() {
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Close menu");
    drawer.classList.add("is-open", "is-animating");
    drawer.setAttribute("aria-hidden", "false");
    drawer.inert = false;
    overlay.classList.add("is-open");
    document.body.classList.add("drawer-open");
    resetCategories();
    renderCategories();
  }

  function close() {
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open menu");
    drawer.classList.remove("is-open", "is-animating");
    drawer.setAttribute("aria-hidden", "true");
    drawer.inert = true;
    overlay.classList.remove("is-open");
    document.body.classList.remove("drawer-open");
    resetCategories();
  }

  toggle.addEventListener("click", () => {
    if (toggle.getAttribute("aria-expanded") === "true") close();
    else open();
  });
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", close);
  categoriesToggle.addEventListener("click", toggleCategories);
  searchInput.addEventListener("input", renderCategories);

  /* Any link in the drawer (a view, a category, the logo or Telegram) closes
     the drawer. Normal <a href> navigation is left alone: the shared preloader
     shows itself on the link click and the browser loads the category filter. */
  drawer.addEventListener("click", (event) => {
    const link = event.target.closest && event.target.closest("a[href]");
    if (!link) return;
    if (link.hasAttribute("data-telegram") && link.getAttribute("href") === "#telegram") {
      event.preventDefault();
    }
    close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  /* Drop the will-change hint as soon as the one-shot spin is over. Telegram
     has the longest stagger delay, so its animationend means all icons are
     done. One listener only — the animation itself is pure CSS. */
  telegramLink.querySelector(".drawer-icon")
    ?.addEventListener("animationend", () => drawer.classList.remove("is-animating"));

  window.SiteNav = Object.freeze({
    setCategories(values) {
      categories = normalizeCategories(values);
      renderCategories();
    },
    setTelegramUrl(url) {
      if (!telegramLink || typeof url !== "string") return;
      const target = url.trim();
      if (!/^https?:\/\//i.test(target)) return;
      telegramLink.href = target;
      telegramLink.target = "_blank";
      telegramLink.rel = "noopener noreferrer";
      telegramLink.classList.remove("is-unconfigured");
      telegramLink.removeAttribute("aria-disabled");
      telegramLink.removeAttribute("title");
    },
    close
  });

  /* Home passes its own categories in once the catalogue has loaded. On other
     pages the drawer needs its own copy of the list and the Telegram link. */
  if (!homeExtras) {
    (async function loadSharedNavData() {
      async function fetchJson(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
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

      const [videosResult, settingsResult] = await Promise.allSettled([
        fetchJson("/api/videos"),
        fetchJson("/api/settings")
      ]);

      if (settingsResult.status === "fulfilled") {
        const settings = settingsResult.value && settingsResult.value.settings;
        if (settings) window.SiteNav.setTelegramUrl(settings.telegramUrl);
      }

      let rows = [];
      if (videosResult.status === "fulfilled") {
        const payload = videosResult.value || {};
        rows = Array.isArray(payload.videos) ? payload.videos : [];
      } else {
        try {
          const sample = await import("/videos.js");
          rows = Array.isArray(sample.videos) ? sample.videos : [];
        } catch (error) {
          rows = [];
        }
      }

      const tags = [];
      rows.forEach((row) => {
        if (!row || typeof row !== "object") return;
        tags.push(row.tag, row.category);
        if (Array.isArray(row.tags)) tags.push(...row.tags);
        else if (typeof row.tags === "string") tags.push(...row.tags.split(","));
      });
      window.SiteNav.setCategories(tags);
    })();
  }
})();
