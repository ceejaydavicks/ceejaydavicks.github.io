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
//
// SAMPLE LIBRARY — the first 25 entries are placeholders that fill the page so
// the layout looks complete. Their thumbnails live in assets/samples/ and their
// URLs point at example.com, so they will not play. To publish a real clip,
// replace `url` (Videy or a direct .mp4) and optionally swap `thumb`; to remove
// one, delete its entry.
// ============================================================================

export const videos = [
  {
    title: "Sample clip 01 — episode",
    url: "https://example.com/demo/01.mp4",
    thumb: "./assets/samples/thumb-01.svg",
    creator: "Noir Studio",
    duration: "1:00",
    views: "5.1K",
    posted: "1d ago",
    category: "Cinematic",
    tag: "4K"
  },
  {
    title: "Sample clip 02 — episode",
    url: "https://example.com/demo/02.mp4",
    thumb: "./assets/samples/thumb-02.svg",
    creator: "Velour Films",
    duration: "2:07",
    views: "6.8K",
    posted: "2d ago",
    category: "Studio"
  },
  {
    title: "Sample clip 03 — episode",
    url: "https://example.com/demo/03.mp4",
    thumb: "./assets/samples/thumb-03.svg",
    creator: "After Hours",
    duration: "3:14",
    views: "8.5K",
    posted: "3d ago",
    category: "Archive"
  },
  {
    title: "Sample clip 04 — episode",
    url: "https://example.com/demo/04.mp4",
    thumb: "./assets/samples/thumb-04.svg",
    creator: "Maison Rose",
    duration: "4:21",
    views: "10.2K",
    posted: "4d ago",
    category: "Cinematic"
  },
  {
    title: "Sample clip 05 — vertical short",
    url: "https://example.com/demo/05.mp4",
    thumb: "./assets/samples/thumb-05.svg",
    creator: "Noir Studio",
    duration: "5:28",
    views: "11.9K",
    posted: "5d ago",
    category: "Studio",
    tag: "4K",
    format: "short"
  },
  {
    title: "Sample clip 06 — vertical short",
    url: "https://example.com/demo/06.mp4",
    thumb: "./assets/samples/thumb-06.svg",
    creator: "Velour Films",
    duration: "6:35",
    views: "13.6K",
    posted: "6d ago",
    category: "Archive",
    format: "short"
  },
  {
    title: "Sample clip 07 — vertical short",
    url: "https://example.com/demo/07.mp4",
    thumb: "./assets/samples/thumb-07.svg",
    creator: "After Hours",
    duration: "7:42",
    views: "15.3K",
    posted: "1d ago",
    category: "Cinematic",
    format: "short"
  },
  {
    title: "Sample clip 08 — vertical short",
    url: "https://example.com/demo/08.mp4",
    thumb: "./assets/samples/thumb-08.svg",
    creator: "Maison Rose",
    duration: "8:49",
    views: "17.0K",
    posted: "2d ago",
    category: "Studio",
    format: "short"
  },
  {
    title: "Sample clip 09 — vertical short",
    url: "https://example.com/demo/09.mp4",
    thumb: "./assets/samples/thumb-09.svg",
    creator: "Noir Studio",
    duration: "9:56",
    views: "18.7K",
    posted: "3d ago",
    category: "Archive",
    tag: "4K",
    format: "short"
  },
  {
    title: "Sample clip 10 — vertical short",
    url: "https://example.com/demo/10.mp4",
    thumb: "./assets/samples/thumb-10.svg",
    creator: "Velour Films",
    duration: "1:03",
    views: "20.4K",
    posted: "4d ago",
    category: "Cinematic",
    format: "short"
  },
  {
    title: "Sample clip 11 — episode",
    url: "https://example.com/demo/11.mp4",
    thumb: "./assets/samples/thumb-11.svg",
    creator: "After Hours",
    duration: "2:10",
    views: "22.1K",
    posted: "5d ago",
    category: "Studio"
  },
  {
    title: "Sample clip 12 — episode",
    url: "https://example.com/demo/12.mp4",
    thumb: "./assets/samples/thumb-12.svg",
    creator: "Maison Rose",
    duration: "3:17",
    views: "23.8K",
    posted: "6d ago",
    category: "Archive"
  },
  {
    title: "Sample clip 13 — episode",
    url: "https://example.com/demo/13.mp4",
    thumb: "./assets/samples/thumb-13.svg",
    creator: "Noir Studio",
    duration: "4:24",
    views: "25.5K",
    posted: "1d ago",
    category: "Cinematic",
    tag: "4K"
  },
  {
    title: "Sample clip 14 — episode",
    url: "https://example.com/demo/14.mp4",
    thumb: "./assets/samples/thumb-14.svg",
    creator: "Velour Films",
    duration: "5:31",
    views: "27.2K",
    posted: "2d ago",
    category: "Studio"
  },
  {
    title: "Sample clip 15 — episode",
    url: "https://example.com/demo/15.mp4",
    thumb: "./assets/samples/thumb-15.svg",
    creator: "After Hours",
    duration: "6:38",
    views: "28.9K",
    posted: "3d ago",
    category: "Archive"
  },
  {
    title: "Sample clip 16 — episode",
    url: "https://example.com/demo/16.mp4",
    thumb: "./assets/samples/thumb-16.svg",
    creator: "Maison Rose",
    duration: "7:45",
    views: "30.6K",
    posted: "4d ago",
    category: "Cinematic"
  },
  {
    title: "Sample clip 17 — episode",
    url: "https://example.com/demo/17.mp4",
    thumb: "./assets/samples/thumb-17.svg",
    creator: "Noir Studio",
    duration: "8:52",
    views: "32.3K",
    posted: "5d ago",
    category: "Studio",
    tag: "4K"
  },
  {
    title: "Sample clip 18 — episode",
    url: "https://example.com/demo/18.mp4",
    thumb: "./assets/samples/thumb-18.svg",
    creator: "Velour Films",
    duration: "9:59",
    views: "34.0K",
    posted: "6d ago",
    category: "Archive"
  },
  {
    title: "Sample clip 19 — episode",
    url: "https://example.com/demo/19.mp4",
    thumb: "./assets/samples/thumb-19.svg",
    creator: "After Hours",
    duration: "1:06",
    views: "35.7K",
    posted: "1d ago",
    category: "Cinematic"
  },
  {
    title: "Sample clip 20 — episode",
    url: "https://example.com/demo/20.mp4",
    thumb: "./assets/samples/thumb-20.svg",
    creator: "Maison Rose",
    duration: "2:13",
    views: "37.4K",
    posted: "2d ago",
    category: "Studio"
  },
  {
    title: "Sample clip 21 — episode",
    url: "https://example.com/demo/21.mp4",
    thumb: "./assets/samples/thumb-21.svg",
    creator: "Noir Studio",
    duration: "3:20",
    views: "39.1K",
    posted: "3d ago",
    category: "Archive",
    tag: "4K"
  },
  {
    title: "Sample clip 22 — episode",
    url: "https://example.com/demo/22.mp4",
    thumb: "./assets/samples/thumb-22.svg",
    creator: "Velour Films",
    duration: "4:27",
    views: "40.8K",
    posted: "4d ago",
    category: "Cinematic"
  },
  {
    title: "Sample clip 23 — episode",
    url: "https://example.com/demo/23.mp4",
    thumb: "./assets/samples/thumb-23.svg",
    creator: "After Hours",
    duration: "5:34",
    views: "42.5K",
    posted: "5d ago",
    category: "Studio"
  },
  {
    title: "Sample clip 24 — episode",
    url: "https://example.com/demo/24.mp4",
    thumb: "./assets/samples/thumb-24.svg",
    creator: "Maison Rose",
    duration: "6:41",
    views: "44.2K",
    posted: "6d ago",
    category: "Archive"
  },
  {
    title: "Sample clip 25 — episode",
    url: "https://example.com/demo/25.mp4",
    thumb: "./assets/samples/thumb-25.svg",
    creator: "Noir Studio",
    duration: "7:48",
    views: "45.9K",
    posted: "1d ago",
    category: "Cinematic",
    tag: "4K"
  },

  // Your original video — kept at the end of the list. Move it to the top to
  // feature it again, or delete it once the library is full of real uploads.
  {
    title: "when it all goes in",
    url: "https://videy.co/v?id=mD3FVR781"
  }
];
