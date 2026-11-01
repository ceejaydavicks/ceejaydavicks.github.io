/* Shared loader behavior. Include after age-gate.js on every public page. */
(function () {
  "use strict";

  if (location.pathname === "/admin" || location.pathname.startsWith("/admin/")) return;
  const body = document.body;
  if (!body) return;

  const overlay = document.createElement("div");
  overlay.className = "preloader";
  overlay.id = "preloader";
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = '<div class="preloader__stage"><span class="preloader__ring"></span><span class="preloader__logo" aria-hidden="true"></span></div>';
  body.prepend(overlay);

  let shownAt = Date.now();
  let safetyTimer = 0;
  let hideTimer = 0;
  const MINIMUM_VISIBLE_MS = 400;
  const MAX_VISIBLE_MS = 8000;

  function show() {
    shownAt = Date.now();
    window.clearTimeout(hideTimer);
    window.clearTimeout(safetyTimer);
    overlay.classList.remove("is-done");
    safetyTimer = window.setTimeout(hide, MAX_VISIBLE_MS);
  }

  function hide() {
    window.clearTimeout(safetyTimer);
    const remaining = Math.max(0, MINIMUM_VISIBLE_MS - (Date.now() - shownAt));
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => overlay.classList.add("is-done"), remaining);
  }

  function isHomePath() {
    return location.pathname === "/" || location.pathname === "/index.html";
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest && event.target.closest("a[href]");
    if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch (_) { return; }
    if (destination.origin !== location.origin) return;

    const isBrand = Boolean(link.closest(".brand"));
    if (isBrand && isHomePath() && (destination.pathname === "/" || destination.pathname === "/index.html")) {
      event.preventDefault();
      if (location.pathname !== "/" || location.search || location.hash) {
        history.replaceState(history.state, "", "/");
      }
      show();
      window.scrollTo({ top: 0, behavior: "smooth" });
      window.setTimeout(hide, MINIMUM_VISIBLE_MS);
      return;
    }

    const sameDocumentHash = destination.pathname === location.pathname &&
      destination.search === location.search && destination.hash;
    if (!sameDocumentHash) show();
  }, true);

  window.addEventListener("popstate", show);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      show();
      window.setTimeout(hide, MINIMUM_VISIBLE_MS);
    }
  });
  window.addEventListener("load", hide, { once: true });
  if (document.readyState === "complete") hide();

  /* Safety net in case a resource or load handler never completes. */
  safetyTimer = window.setTimeout(hide, MAX_VISIBLE_MS);
})();
