/* ============================================================================
   LINK PREVIEW ("SHARE IMAGE") GENERATOR — admin only
   ----------------------------------------------------------------------------
   Draws a 1200x630 JPG in the browser and hands it back as a Blob for
   /api/share-image to store in R2. Classic script so the same edge versioning
   that protects the other JS files applies here too.

   Portrait thumbnails: the sharp picture is centred at its natural ratio (no
   crop) over a blurred, darkened copy that fills the card.
   Landscape thumbnails: the sharp picture fills the card (cover).
   Both get a small play button, a duration pill in one corner and the small
   logo mark in the opposite corner.

   The source picture is fetched through /api/share-image?videoId=… on this
   same origin, so the canvas is never tainted by a cross-origin poster.
   ========================================================================== */
(function () {
  "use strict";

  var WIDTH = 1200;
  var HEIGHT = 630;
  var MAX_BYTES = 300 * 1024;
  var LOGO_SRC = "/assets/apple-touch-icon.png";
  var PLACEHOLDER = "/assets/embed-placeholder.webp";
  var FONT = '600 28px Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = function () {
        if (image.naturalWidth && image.naturalHeight) resolve(image);
        else reject(new Error("The image was empty."));
      };
      image.onerror = function () { reject(new Error("The image could not be loaded.")); };
      image.src = src;
    });
  }

  function durationLabel(video) {
    var raw = String((video && video.duration) || "").trim().slice(0, 12);
    if (raw) return raw;
    var seconds = Number(video && video.duration_seconds) || 0;
    if (seconds <= 0) return "";
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }

  function coverRect(sw, sh, dw, dh) {
    var scale = Math.max(dw / sw, dh / sh);
    var w = sw * scale;
    var h = sh * scale;
    return { x: (dw - w) / 2, y: (dh - h) / 2, w: w, h: h };
  }

  function containRect(sw, sh, dw, dh) {
    var scale = Math.min(dw / sw, dh / sh);
    var w = sw * scale;
    var h = sh * scale;
    return { x: (dw - w) / 2, y: (dh - h) / 2, w: w, h: h };
  }

  function roundPath(ctx, x, y, w, h, radius) {
    var r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Downsample + upscale gives a real blur on every browser, including ones
     without ctx.filter. A dark veil keeps the sharp subject readable. */
  function drawBlurredBackground(ctx, image, cover) {
    var tiny = document.createElement("canvas");
    tiny.width = 48;
    tiny.height = 25;
    var small = tiny.getContext("2d");
    if (!small) return;
    small.drawImage(image, cover.x, cover.y, cover.w, cover.h, 0, 0, tiny.width, tiny.height);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.filter = "blur(14px) brightness(0.5) saturate(1.15)";
      ctx.drawImage(tiny, 0, 0, WIDTH, HEIGHT);
    } catch (error) {
      ctx.drawImage(tiny, 0, 0, WIDTH, HEIGHT);
    }
    ctx.restore();
    ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function drawSharp(ctx, image, portrait) {
    var sw = image.naturalWidth;
    var sh = image.naturalHeight;
    var rect;
    if (portrait) {
      var padX = 48;
      var padY = 40;
      rect = containRect(sw, sh, WIDTH - padX * 2, HEIGHT - padY * 2);
      rect.x += padX;
      rect.y += padY;
    } else {
      rect = coverRect(sw, sh, WIDTH, HEIGHT);
    }

    ctx.save();
    if (portrait) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
      ctx.shadowBlur = 36;
      ctx.shadowOffsetY = 10;
      roundPath(ctx, rect.x, rect.y, rect.w, rect.h, 22);
      ctx.fillStyle = "#0b0b0e";
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.clip();
    }
    /* For landscape, coverRect already crops centrally; clip to the card. */
    if (!portrait) {
      ctx.beginPath();
      ctx.rect(0, 0, WIDTH, HEIGHT);
      ctx.clip();
    }
    ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    return rect;
  }

  function drawOverlays(ctx, video, logo) {
    /* A gentle bottom gradient keeps the white pill/logo legible. */
    var gradient = ctx.createLinearGradient(0, HEIGHT * 0.55, 0, HEIGHT);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, HEIGHT * 0.55, WIDTH, HEIGHT * 0.45);

    /* Small play button, dead centre. */
    var cx = WIDTH / 2;
    var cy = HEIGHT / 2;
    var radius = 46;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8, 8, 12, 0.62)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy - 18);
    ctx.lineTo(cx + 22, cy);
    ctx.lineTo(cx - 12, cy + 18);
    ctx.closePath();
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.restore();

    /* Duration pill, bottom-left. */
    var label = durationLabel(video);
    if (label) {
      ctx.save();
      ctx.font = FONT;
      var textWidth = ctx.measureText(label).width;
      var pillW = textWidth + 44;
      var pillH = 48;
      var px = 36;
      var py = HEIGHT - 36 - pillH;
      roundPath(ctx, px, py, pillW, pillH, pillH / 2);
      ctx.fillStyle = "rgba(8, 8, 12, 0.82)";
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, px + pillW / 2, py + pillH / 2 + 1);
      ctx.restore();
    }

    /* Small logo mark, bottom-right — the opposite corner. */
    if (logo) {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
      ctx.shadowBlur = 14;
      var size = 64;
      ctx.drawImage(logo, WIDTH - 36 - size, HEIGHT - 36 - size, size, size);
      ctx.restore();
    }
  }

  function toJpeg(canvas, quality) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (blob) { resolve(blob); }, "image/jpeg", quality);
      } catch (error) {
        reject(error);
      }
    });
  }

  /* Resolves { blob, width, height, size, layout, sourceWidth, sourceHeight }. */
  async function create(video) {
    var id = String((video && video.id != null) ? video.id : "")
      .replace(/[^0-9]/g, "").slice(0, 20);
    if (!id) throw new Error("This video has no id yet.");

    var thumb = String((video && video.thumbnail_url) || "").trim();
    if (!thumb || thumb === PLACEHOLDER || thumb.endsWith("/embed-placeholder.webp")) {
      throw new Error("This video has no thumbnail.");
    }

    var source = "/api/share-image?videoId=" + encodeURIComponent(id);
    var image = await loadImage(source);
    var logo = null;
    try { logo = await loadImage(LOGO_SRC); } catch (error) { logo = null; }

    var canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available in this browser.");

    ctx.fillStyle = "#07070A";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    var sw = image.naturalWidth;
    var sh = image.naturalHeight;
    var portrait = sh > sw * 1.05;
    drawBlurredBackground(ctx, image, coverRect(sw, sh, WIDTH, HEIGHT));
    drawSharp(ctx, image, portrait);
    drawOverlays(ctx, video, logo);

    var blob = null;
    var qualities = [0.86, 0.78, 0.68, 0.58, 0.48, 0.4];
    for (var i = 0; i < qualities.length; i += 1) {
      try {
        blob = await toJpeg(canvas, qualities[i]);
      } catch (error) {
        throw new Error("The thumbnail could not be used (blocked by its host). Upload a picture instead.");
      }
      if (blob && blob.type === "image/jpeg" && blob.size <= MAX_BYTES) break;
    }
    if (!blob || blob.type !== "image/jpeg") {
      throw new Error("The browser could not save the share image.");
    }
    if (blob.size > MAX_BYTES) {
      throw new Error("The share image is over 300 KB.");
    }

    return {
      blob: blob,
      width: WIDTH,
      height: HEIGHT,
      size: blob.size,
      layout: portrait ? "portrait" : "landscape",
      sourceWidth: sw,
      sourceHeight: sh
    };
  }

  window.ShareImage = {
    create: create,
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    MAX_BYTES: MAX_BYTES
  };
})();
