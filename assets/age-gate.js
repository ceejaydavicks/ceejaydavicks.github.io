/* ============================================================================
   18+ AGE GATE
   ----------------------------------------------------------------------------
   Load this before any page content (right after <body>). It runs
   synchronously, so a locked page never flashes its content. The choice is
   remembered for 30 days in localStorage, with a cookie fallback for browsers
   that block storage.

   Behaviour:
   - full-screen dark overlay with the logo, the required 18+ copy, an Enter
     button and an Exit link to https://www.google.com;
   - background scrolling and interaction are blocked while it is open;
   - focus is moved into the dialog and trapped there;
   - Escape never dismisses the gate (it is swallowed);
   - keyboard, screen-reader and mobile friendly.

   Pages that include this script must also hide `html.age-locked` content —
   index.html and the legal pages do, via the `.age-locked` rules in their CSS.
   ========================================================================== */
(function () {
  "use strict";

  var STORAGE_KEY = "ageVerifiedUntil";
  var COOKIE_NAME = "age_ok";
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  var root = document.documentElement;

  var overlay = null;
  var lastFocused = null;
  var lockedRegions = [];
  var onKeydown = null;
  var accepted = false;

  function hasValidStamp() {
    try {
      var until = Number(window.localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(until) && until > Date.now();
    } catch (error) {
      return false;
    }
  }

  function hasCookie() {
    return new RegExp("(?:^|;\\s*)" + COOKIE_NAME + "=1(?:;|$)").test(document.cookie);
  }

  function remember() {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now() + MAX_AGE_MS));
    } catch (error) {
      /* Storage blocked — the cookie below still covers the next visits. */
    }

    var secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      COOKIE_NAME + "=1; max-age=" + Math.round(MAX_AGE_MS / 1000) +
      "; path=/; SameSite=Lax" + secure;
  }

  function siteName() {
    var node = document.querySelector("[data-site-name]");
    var text = node && node.textContent ? node.textContent.trim() : "";
    return text || "BootyMansion";
  }

  var STYLES = [
    ".age-gate{position:fixed;z-index:9999;inset:0;display:flex;align-items:center;justify-content:center;",
    "padding:clamp(1rem,4vw,2.5rem);overflow-y:auto;overscroll-behavior:contain;",
    "background:radial-gradient(ellipse 70% 55% at 50% -8%,rgba(244,63,94,.12),transparent 62%),#0B0B0F;",
    "color:#F4F4F6;font-family:\"Inter\",ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",sans-serif;",
    "-webkit-overflow-scrolling:touch}",

    ".age-gate__panel{width:min(440px,100%);margin:auto;padding:clamp(1.6rem,5vw,2.4rem);",
    "border:1px solid #26262F;border-radius:24px;text-align:center;",
    "background:linear-gradient(160deg,rgba(21,21,27,.98),rgba(11,11,15,.98));",
    "box-shadow:0 30px 80px rgba(5,2,12,.62)}",

    ".age-gate__logo{display:block;width:min(240px,72%);aspect-ratio:707/108;margin:0 auto 1.3rem;",
    "background:url(\"./assets/logo-lockup@3x.png\") center/contain no-repeat}",

    ".age-gate__badge{display:inline-block;padding:.22rem .7rem;border:1px solid rgba(244,63,94,.4);",
    "border-radius:999px;color:#FB7185;font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase}",

    ".age-gate__title{margin:1rem 0 .6rem;font-size:clamp(1.25rem,4.6vw,1.55rem);font-weight:600;",
    "letter-spacing:-.02em;line-height:1.25}",

    ".age-gate__copy{margin:0;color:#C9C9D4;font-size:14px;line-height:1.6}",

    ".age-gate__actions{display:grid;gap:.6rem;margin-top:1.5rem}",

    ".age-gate__enter{display:block;width:100%;padding:.9rem 1.1rem;border:1px solid transparent;border-radius:12px;",
    "background:linear-gradient(135deg,#E11D48 0%,#BE123C 100%);color:#FFFFFF;text-shadow:0 1px 2px rgba(10,6,20,.4);",
    "font:inherit;font-size:14px;font-weight:600;cursor:pointer;",
    "transition:background .16s ease,transform .16s ease}",

    ".age-gate__enter:hover{background:linear-gradient(135deg,#F43F5E 0%,#E11D48 100%)}",
    ".age-gate__enter:active{transform:scale(.99)}",

    ".age-gate__exit{display:block;width:100%;padding:.85rem 1.1rem;border:1px solid #33333E;",
    "border-radius:12px;color:#F4F4F6;font-size:13.5px;font-weight:500;text-decoration:none;",
    "transition:border-color .16s ease,color .16s ease}",

    ".age-gate__exit:hover{border-color:rgba(251,113,133,.6);color:#FB7185}",

    ".age-gate__note{margin:1.2rem 0 0;color:#9A9AA8;font-size:11.5px;line-height:1.55}",
    ".age-gate__note a{color:#FB7185;text-decoration:underline;text-underline-offset:3px}",

    ".age-gate :focus-visible{outline:2px solid #FB7185;outline-offset:3px}",

    "@media (min-width:520px){.age-gate__actions{grid-template-columns:1fr 1fr}}",

    "@media (prefers-reduced-motion:reduce){.age-gate__enter,.age-gate__exit{transition:none}}"
  ].join("");

  function injectStyles() {
    if (document.getElementById("age-gate-styles")) return;
    var style = document.createElement("style");
    style.id = "age-gate-styles";
    style.textContent = STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  function focusable() {
    if (!overlay) return [];
    // Everything the overlay renders is visible, so no offsetParent filtering
    // (a fixed-position ancestor can report null in some engines).
    return Array.prototype.slice.call(
      overlay.querySelectorAll("a[href], button:not([disabled])")
    );
  }

  function handleKeydown(event) {
    if (!overlay) return;

    // Escape must never close the gate.
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key !== "Tab") return;

    var items = focusable();
    if (!items.length) return;

    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;

    if (!overlay.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function lockRegions() {
    var regions = document.querySelectorAll("header, main, footer, .preloader");
    lockedRegions = Array.prototype.slice.call(regions);
    lockedRegions.forEach(function (region) {
      if (region.hasAttribute("inert")) return;
      region.setAttribute("inert", "");
      region.setAttribute("aria-hidden", "true");
    });
  }

  function unlockRegions() {
    lockedRegions.forEach(function (region) {
      region.removeAttribute("inert");
      region.removeAttribute("aria-hidden");
    });
    lockedRegions = [];
  }

  function build() {
    injectStyles();

    overlay = document.createElement("div");
    overlay.className = "age-gate";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "age-gate-title");
    overlay.setAttribute("aria-describedby", "age-gate-copy");

    var name = siteName();
    overlay.innerHTML = [
      '<div class="age-gate__panel">',
      '<span class="age-gate__logo" role="img" aria-label="' + name + '"></span>',
      '<span class="age-gate__badge">18+ only</span>',
      '<h1 class="age-gate__title" id="age-gate-title">Are you 18 or older?</h1>',
      '<p class="age-gate__copy" id="age-gate-copy">This website contains adult content. You must be 18 or older to enter.</p>',
      '<div class="age-gate__actions">',
      '<button type="button" class="age-gate__enter" data-age-enter>I am 18 or older - Enter</button>',
      '<a class="age-gate__exit" href="https://www.google.com" rel="noopener noreferrer">Exit</a>',
      "</div>",
      '<p class="age-gate__note">By entering you confirm you are of legal age where you live and accept the ' +
        '<a href="./terms.html">Terms</a> and <a href="./privacy.html">Privacy Policy</a>.</p>',
      "</div>"
    ].join("");

    document.body.appendChild(overlay);

    lastFocused = document.activeElement;
    onKeydown = handleKeydown;
    document.addEventListener("keydown", onKeydown, true);

    var enter = overlay.querySelector("[data-age-enter]");
    if (enter) {
      enter.addEventListener("click", accept);
      window.requestAnimationFrame(function () {
        if (enter) enter.focus();
      });
    }
  }

  function accept() {
    if (accepted) return;
    accepted = true;

    remember();

    root.classList.remove("age-locked");
    root.classList.add("age-passed");

    document.removeEventListener("keydown", onKeydown, true);
    onKeydown = null;

    unlockRegions();

    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;

    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    } else {
      document.body.setAttribute("tabindex", "-1");
      document.body.focus();
      document.body.removeAttribute("tabindex");
    }
  }

  if (hasValidStamp() || hasCookie()) {
    root.classList.add("age-passed");
    return;
  }

  root.classList.add("age-locked");

  if (document.body) {
    build();
    document.addEventListener("DOMContentLoaded", function () {
      if (accepted || !overlay) return;
      lockRegions();
    });
  } else {
    // Extremely defensive: the script was placed before <body> existed.
    document.addEventListener("DOMContentLoaded", function () {
      if (!hasValidStamp() && !hasCookie()) build();
    });
  }
})();
