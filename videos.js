// ============================================================================
// VIDEO LIBRARY
// ----------------------------------------------------------------------------
// Every card, row, chip and the featured player are built from this list, so a
// new upload appears automatically the next time the page loads — no HTML edits.
//
// REQUIRED
//   { title, url }
//
// OPTIONAL (shown only when you provide it — nothing is invented for you)
//   thumb        poster image URL; if omitted, a frame is read from the video
//   creator      shown under the title
//   views        display text, e.g. "12.4K" (this site has no analytics for it)
//   duration     "12:48"; read from the video file when omitted
//   category     adds a filter chip, e.g. "Cinematic"
//   posted       display text, e.g. "2d ago"
//   tag          corner badge, e.g. "4K" or "New"
//   description  one line shown beside the featured video
//   format       "short" marks a vertical 9:16 clip for the Vertical Shorts row
//
// NOTE: keep `url` absolute (https://…). Entries without a valid http(s) URL are
// skipped so a typo never produces a broken card. Videy share links play through
// their CDN file; direct .mp4 links play as-is.
// ============================================================================

export const videos = [
  {
    title: "when it all goes in",
    url: "https://videy.co/v?id=mD3FVR781"
  }
];
