/* Shared duration parsing and the site's single Shorts rule. */
(function (root) {
  "use strict";

  function seconds(value) {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
    const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!raw) return 0;
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) || 0;
    const parts = raw.split(":").map((part) => part.trim());
    if (parts.length >= 2 && parts.length <= 3 && parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) {
      return parts.map(Number).reduce((total, part) => total * 60 + part, 0);
    }
    const match = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/.exec(raw);
    if (match && (match[1] || match[2] || match[3])) {
      return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
    }
    return 0;
  }

  root.VideoRules = Object.freeze({
    seconds,
    isShort(value) {
      const duration = seconds(value);
      return duration > 0 && duration <= 60;
    }
  });
})(window);
