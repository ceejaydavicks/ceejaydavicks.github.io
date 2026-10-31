-- ---------------------------------------------------------------------------
-- BootyMansion admin schema (Cloudflare D1)
--
-- The Pages Functions create these tables automatically on the first request,
-- so running this file is optional. Databases created by an older build are
-- upgraded in place on the first request (missing columns are added, the
-- Telegram index is created). It is here for reference and for anyone who
-- prefers `npx wrangler d1 execute <db> --remote --file=./schema.sql`.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  creator TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  embed_url TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',           -- display label, e.g. "12:48"
  duration_seconds INTEGER NOT NULL DEFAULT 0,  -- 0 = unknown; < 60 means a Short
  "views" TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  orientation TEXT NOT NULL DEFAULT 'horizontal',
  featured INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  tg_chat TEXT,          -- channel a video was published from (NULL for manual rows)
  tg_message_id INTEGER,
  source_url TEXT NOT NULL DEFAULT '',  -- page a scraped row came from
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS videos_order_idx
  ON videos (featured DESC, pinned DESC, created_at DESC);

-- One Telegram message may only ever produce one row (webhook retries).
CREATE UNIQUE INDEX IF NOT EXISTS videos_tg_idx
  ON videos (tg_chat, tg_message_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', 'BootyMansion'),
  ('telegram_url', ''),
  ('ad_banner_code', ''),
  ('ad_native_code', ''),
  ('ad_smartlink_url', ''),
  ('ad_smartlink_code', '');
