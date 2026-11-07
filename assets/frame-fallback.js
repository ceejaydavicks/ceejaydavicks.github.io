/* ============================================================================
   Lightweight first-frame fallback for cards with NO saved thumbnail.
   ----------------------------------------------------------------------------
   Only used for direct video file URLs (the API sends `frame_url` solely for
   those rows). Designed to keep the performance gains of the previous pass:

   - a card must be within 200px of the viewport before anything is fetched
   - at most 4 <video> elements exist at the same time (loading or paused)
   - each element is muted, playsinline, preload="metadata", has no controls,
     and its src ends in #t=0.5 so the browser decodes one frame only
   - as soon as the frame is readable it is drawn to a 480px canvas, swapped
     into the card's <img> and the <video> is removed; when the host taints the
     canvas the paused <video> itself stays as the (non-playing) card image
   - a failure/timeout removes the element and leaves the logo placeholder
   ========================================================================== */
(function () {
  "use strict";

  var MAX_VIDEOS = 4;
  /* A dead link host used to hold one of the four capture slots for 9 seconds,
     and every card from that host tried again. Fail fast and remember it. */
  var TIMEOUT_MS = 5000;
  var CAPTURE_WIDTH = 480;
  var failedHosts = new Set();

  function hostOf(url) {
    try { return new URL(url, window.location.href).host; } catch (error) { return ""; }
  }

  var slots = [];       // jobs that currently own a live <video>
  var waiting = [];     // jobs waiting for the viewport or a free slot
  var observer = null;

  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var job = entry.target.__frameJob;
        if (!job || !entry.isIntersecting) return;
        observer.unobserve(entry.target);
        job.visible = true;
        waiting.push(job);
        pump();
      });
    }, { rootMargin: "200px 0px" });
  }

  function safeUrl(value) {
    try {
      var parsed = new URL(String(value || ""), window.location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch (error) {
      return "";
    }
  }

  function removeVideo(job) {
    if (!job.video) return;
    try {
      job.video.pause();
      job.video.removeAttribute("src");
      job.video.load();
    } catch (error) { /* already gone */ }
    if (job.video.parentNode) job.video.parentNode.removeChild(job.video);
    job.video = null;
  }

  function evict(job) {
    removeVideo(job);
    job.done = true;
    if (typeof job.onFail === "function") job.onFail();
  }

  function pump() {
    var guard = 0;
    while (waiting.length && guard < 60) {
      guard += 1;
      if (slots.length < MAX_VIDEOS) {
        var job = waiting.shift();
        if (!job.done && job.card && job.card.isConnected) start(job);
        continue;
      }
      // All four slots are taken. Reuse the oldest slot that has already
      // rendered its frame (it is paused, so nothing is still downloading).
      var index = -1;
      for (var i = 0; i < slots.length; i += 1) {
        if (slots[i].loaded) { index = i; break; }
      }
      if (index < 0) return; // all four are still loading; wait for them
      evict(slots.splice(index, 1)[0]);
    }
  }

  function release(job) {
    var index = slots.indexOf(job);
    if (index >= 0) slots.splice(index, 1);
    pump();
  }

  function blankFrame(canvas, context) {
    try {
      var w = canvas.width, h = canvas.height;
      var data = context.getImageData(0, 0, w, h).data;
      var min = 255, max = 0, total = 0, count = 0;
      var step = Math.max(1, Math.floor((w * h) / 400)) * 4;
      for (var i = 0; i < data.length; i += step) {
        var v = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (v < min) min = v;
        if (v > max) max = v;
        total += v;
        count += 1;
      }
      // Completely flat or essentially black: not a usable poster.
      return count === 0 || max - min < 3 || total / count < 4;
    } catch (error) {
      return false;
    }
  }

  function settle(job, kind, dataUrl) {
    if (job.done) return;
    job.done = true;
    window.clearTimeout(job.timer);
    job.loaded = true;

    if (kind === "fail") {
      var host = hostOf(job.url);
      if (host) failedHosts.add(host);
      removeVideo(job);
      if (typeof job.onFail === "function") job.onFail();
      release(job);
      return;
    }

    if (job.video) {
      try { job.video.pause(); } catch (error) { /* noop */ }
      job.video.removeAttribute("controls");
      job.video.preload = "none";
    }

    if (kind === "captured") {
      removeVideo(job);
      if (typeof job.onFrame === "function") job.onFrame(dataUrl);
      release(job);
      return;
    }

    // Canvas was tainted: keep the paused <video> as the visible card image.
    // It never plays and never buffers further; the slot is reusable.
    if (typeof job.onFrame === "function") job.onFrame(null);
    pump();
  }

  function start(job) {
    var src = job.url;
    if (src.indexOf("#") >= 0) src = src.slice(0, src.indexOf("#"));
    src += "#t=0.5";

    var video = document.createElement("video");
    video.className = "poster__media poster__frame";
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.preload = "metadata";
    video.controls = false;
    video.tabIndex = -1;
    video.setAttribute("aria-hidden", "true");
    video.setAttribute("disablepictureinpicture", "");
    job.video = video;
    job.loaded = false;
    slots.push(job);

    var captured = false;
    var grab = function () {
      if (captured || job.done) return;
      if (!video.videoWidth || !video.videoHeight) return;
      captured = true;
      try { video.pause(); } catch (error) { /* noop */ }
      try {
        var scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth);
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        var context = canvas.getContext("2d");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (blankFrame(canvas, context)) throw new Error("blank frame");
        var dataUrl = canvas.toDataURL("image/webp", 0.72);
        if (!dataUrl || dataUrl.indexOf("image/") < 0) dataUrl = canvas.toDataURL("image/jpeg", 0.72);
        settle(job, "captured", dataUrl);
      } catch (error) {
        // SecurityError = cross-origin host without CORS. The paused video is
        // still a perfectly good still frame.
        settle(job, "paused", null);
      }
    };

    video.addEventListener("loadeddata", grab, { once: true });
    video.addEventListener("seeked", grab, { once: true });
    video.addEventListener("error", function () { settle(job, "fail", null); }, { once: true });
    job.timer = window.setTimeout(function () { settle(job, "fail", null); }, TIMEOUT_MS);

    job.card.appendChild(video);
    try { video.src = src; video.load(); } catch (error) { settle(job, "fail", null); }
  }

  window.FrameFallback = {
    /* request(card, frameUrl, onFrame, onFail)
       onFrame(dataUrl|null): dataUrl is a captured 480px still, null means the
       paused <video> itself is visible. onFail(): keep the logo placeholder. */
    request: function (card, frameUrl, onFrame, onFail) {
      var url = safeUrl(frameUrl);
      if (!card || !url) { if (onFail) onFail(); return null; }
      if (failedHosts.has(hostOf(url))) { if (onFail) onFail(); return null; }
      var job = {
        card: card, url: url, onFrame: onFrame, onFail: onFail,
        visible: !observer, done: false, loaded: false, video: null, timer: 0
      };
      card.__frameJob = job;
      if (observer) observer.observe(card);
      else { waiting.push(job); pump(); }
      return {
        cancel: function () {
          job.done = true;
          if (observer) observer.unobserve(card);
          removeVideo(job);
          release(job);
        }
      };
    },
    maxConcurrent: MAX_VIDEOS
  };
})();
