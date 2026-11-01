/* ============================================================================
   D1 data access. The schema is created automatically on first use (cheap
   `CREATE TABLE IF NOT EXISTS` guarded by an in-isolate promise), and the same
   statements live in schema.sql for `wrangler d1 execute`.
   ========================================================================== */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    creator TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    video_url TEXT NOT NULL DEFAULT '',
    embed_url TEXT NOT NULL DEFAULT '',
    duration TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    "views" TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    orientation TEXT NOT NULL DEFAULT 'horizontal',
    featured INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'site',
    source_id TEXT NOT NULL DEFAULT '',
    thumb_source TEXT NOT NULL DEFAULT '',
    tg_chat TEXT,
    tg_message_id INTEGER,
    source_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS videos_order_idx
     ON videos (featured DESC, pinned DESC, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  /* Rows that came from another catalogue (the Telegram bot's own KV feed).
     The site mirrors them into `videos` so the admin panel and the public page
     read the same table. A deletion has to be remembered here, otherwise the
     next sync would bring the video back. */
  `CREATE TABLE IF NOT EXISTS deleted_sources (
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, source_id)
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    first_at INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0
  )`
];

const DEFAULT_SETTINGS = {
  site_name: "BootyMansion",
  telegram_url: "",
  ad_banner_code: "",
  ad_native_code: "",
  ad_smartlink_url: "",
  ad_smartlink_code: ""
};

/* Columns added after the first release. Databases created by an older build
   get them through this list; fresh databases already have them in SCHEMA.
   `ALTER TABLE ... ADD COLUMN` cannot be made conditional in SQLite, so each one
   is attempted and a "duplicate column" error is ignored. */
const LATE_COLUMNS = [
  ["tg_chat", "ALTER TABLE videos ADD COLUMN tg_chat TEXT"],
  ["tg_message_id", "ALTER TABLE videos ADD COLUMN tg_message_id INTEGER"],
  /* The page a scraped row came from. Kept separately from video_url because a
     mirrored file lives in R2 under a fresh key every time — without this, the
     same page pasted twice looked like a different video. */
  ["source_url", "ALTER TABLE videos ADD COLUMN source_url TEXT NOT NULL DEFAULT ''"],
  /* Real length in seconds. `duration` stays as the m:ss label the cards show;
     this column is what the Shorts rule reads (under 60s = Short), so the same
     video behaves the same whether it arrived from /admin, a link or Telegram. */
  ["duration_seconds", "ALTER TABLE videos ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0"],
  /* The longer description shown under the title (home hero, watch page). */
  ["caption", "ALTER TABLE videos ADD COLUMN caption TEXT NOT NULL DEFAULT ''"],
  /* Every tag of a video, comma separated. `tag` stays the one shown on the
     card corner; `tags` is what the "more like this" ranking compares. */
  ["tags", "ALTER TABLE videos ADD COLUMN tags TEXT NOT NULL DEFAULT ''"],
  /* Where the row came from: "site" (added in the admin panel) or "bot" (the
     Telegram bot's own catalogue, mirrored in). */
  ["source", "ALTER TABLE videos ADD COLUMN source TEXT NOT NULL DEFAULT 'site'"],
  /* The id of the row in its original catalogue, so a mirror can be matched. */
  ["source_id", "ALTER TABLE videos ADD COLUMN source_id TEXT NOT NULL DEFAULT ''"],
  /* How the thumbnail was made: "manual" (uploaded by the admin), "auto" (a
     frame captured from the file), "telegram" (Telegram's own poster) or
     "embed" (the provider's thumbnail). A manual thumbnail always wins. */
  ["thumb_source", "ALTER TABLE videos ADD COLUMN thumb_source TEXT NOT NULL DEFAULT ''"]
];

/* One Telegram message may only ever produce one row: webhook updates are
   retried by Telegram, and a retried update must not duplicate a video. */
const LATE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS videos_tg_idx ON videos (tg_chat, tg_message_id)"
];

async function migrate(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(videos)").all();
  const existing = new Set((results || []).map((row) => row.name));
  for (const [name, sql] of LATE_COLUMNS) {
    if (existing.has(name)) continue;
    try {
      await env.DB.prepare(sql).run();
    } catch (error) {
      if (!/duplicate column/i.test(String(error && error.message))) throw error;
    }
  }
  for (const sql of LATE_INDEXES) {
    try {
      await env.DB.prepare(sql).run();
    } catch (error) {
      /* An index that already exists, or duplicate rows from before the index
         existed, must not take the whole site down. */
      if (!/already exists|UNIQUE constraint/i.test(String(error && error.message))) throw error;
    }
  }
}

let schemaPromise = null;

export function ensureSchema(env) {
  if (!env.DB) throw new Error("Missing D1 binding named DB");
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
      await migrate(env);
      const seed = env.DB.prepare(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
      );
      await env.DB.batch(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => seed.bind(key, value)));
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export const VIDEO_COLUMNS = [
  "id",
  "title",
  "creator",
  "thumbnail_url",
  "video_url",
  "embed_url",
  "duration",
  "duration_seconds",
  "views",
  "tag",
  "tags",
  "caption",
  "orientation",
  "featured",
  "pinned",
  "source",
  "source_id",
  "thumb_source",
  "source_url",
  "created_at"
].join(", ");

export async function listVideos(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${VIDEO_COLUMNS} FROM videos
     ORDER BY featured DESC, pinned DESC, datetime(created_at) DESC, id DESC`
  ).all();
  return results || [];
}

export async function listPublishedVideos(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${VIDEO_COLUMNS} FROM videos
     WHERE video_url <> '' OR embed_url <> ''
     ORDER BY featured DESC, pinned DESC, datetime(created_at) DESC, id DESC`
  ).all();
  return results || [];
}

export async function getVideo(env, id) {
  return env.DB.prepare(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE id = ?`).bind(id).first();
}

/* Only one video is featured at a time: setting the flag clears it everywhere
   else, so the home page always has exactly one pinned video to show. */
async function clearOtherFeatured(env, id) {
  await env.DB.prepare("UPDATE videos SET featured = 0 WHERE id <> ?").bind(id).run();
}

export async function insertVideo(env, values) {
  const result = await env.DB.prepare(
    `INSERT INTO videos
       (title, creator, thumbnail_url, video_url, embed_url, duration, duration_seconds,
        "views", tag, tags, caption, orientation, featured, pinned, source, source_id,
        thumb_source, tg_chat, tg_message_id, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      values.title,
      values.creator,
      values.thumbnail_url,
      values.video_url,
      values.embed_url,
      values.duration,
      values.duration_seconds || 0,
      values.views,
      values.tag,
      values.tags || "",
      values.caption || "",
      values.orientation,
      values.featured,
      values.pinned,
      values.source || "site",
      values.source_id || "",
      /* A picture that came with the Telegram message is Telegram's own. */
      values.thumb_source ||
        (values.thumbnail_url && (values.tg_chat || values.tg_message_id) ? "telegram" : ""),
      values.tg_chat === undefined ? null : values.tg_chat,
      values.tg_message_id === undefined ? null : values.tg_message_id,
      values.source_url === undefined ? "" : values.source_url,
      values.created_at === undefined || values.created_at === null
        ? new Date().toISOString().slice(0, 19).replace("T", " ")
        : values.created_at
    )
    .run();

  const id = result.meta && result.meta.last_row_id;
  if (values.featured && id) {
    await clearOtherFeatured(env, id);
  }
  return getVideo(env, id);
}

export async function updateVideo(env, id, values) {
  await env.DB.prepare(
    `UPDATE videos SET
       title = ?, creator = ?, thumbnail_url = ?, video_url = ?, embed_url = ?,
       duration = ?, duration_seconds = ?, "views" = ?, tag = ?, tags = ?, caption = ?,
       orientation = ?, featured = ?, pinned = ?, thumb_source = ?
     WHERE id = ?`
  )
    .bind(
      values.title,
      values.creator,
      values.thumbnail_url,
      values.video_url,
      values.embed_url,
      values.duration,
      values.duration_seconds || 0,
      values.views,
      values.tag,
      values.tags || "",
      values.caption || "",
      values.orientation,
      values.featured,
      values.pinned,
      values.thumb_source || "",
      id
    )
    .run();

  if (values.featured) {
    await clearOtherFeatured(env, id);
  }
  return getVideo(env, id);
}

export async function deleteVideo(env, id) {
  await env.DB.prepare("DELETE FROM videos WHERE id = ?").bind(id).run();
}

/* ---- mirrored catalogues (the Telegram bot's own video list) ------------ */

/* The row that mirrors a given id of another catalogue, if it is known. */
export async function findVideoBySource(env, source, sourceId) {
  if (!source || !sourceId) return null;
  return env.DB
    .prepare(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE source = ? AND source_id = ? LIMIT 1`)
    .bind(source, sourceId)
    .first();
}

/* Remembers that a mirrored row was deleted, so the next sync does not
   bring it back. */
export async function markSourceDeleted(env, source, sourceId) {
  if (!source || !sourceId) return;
  await env.DB
    .prepare(
      "INSERT OR IGNORE INTO deleted_sources (source, source_id) VALUES (?, ?)"
    )
    .bind(source, sourceId)
    .run();
}

export async function isSourceDeleted(env, source, sourceId) {
  if (!source || !sourceId) return false;
  const row = await env.DB
    .prepare("SELECT source_id FROM deleted_sources WHERE source = ? AND source_id = ?")
    .bind(source, sourceId)
    .first();
  return Boolean(row);
}

/* ---- telegram source tracking ------------------------------------------ */

export async function findVideoByTelegram(env, chat, messageId) {
  return env.DB
    .prepare(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE tg_chat = ? AND tg_message_id = ?`)
    .bind(String(chat), Number(messageId))
    .first();
}

/* Scraped links are deduped on the playable URL: re-pasting a page (or a
   Telegram webhook retry) must not add the same video twice. */
export async function findVideoBySourceUrl(env, urls) {
  const values = [...new Set((urls || []).filter((url) => typeof url === "string" && url))];
  if (!values.length) return null;

  const placeholders = values.map(() => "?").join(", ");
  return env.DB
    .prepare(
      `SELECT ${VIDEO_COLUMNS} FROM videos
     WHERE source_url IN (${placeholders})
        OR video_url IN (${placeholders})
        OR embed_url IN (${placeholders})
     LIMIT 1`
    )
    .bind(...values, ...values, ...values)
    .first();
}

/* Where a row came from, so /delete can also remove the channel message. */
export async function getVideoSourceRefs(env, id) {
  return env.DB
    .prepare("SELECT tg_chat, tg_message_id, source, source_id FROM videos WHERE id = ?")
    .bind(id)
    .first();
}

export async function setVideoFlags(env, id, { featured, pinned }) {
  if (featured !== undefined) {
    await env.DB.prepare("UPDATE videos SET featured = ? WHERE id = ?").bind(featured, id).run();
    if (featured) {
      await clearOtherFeatured(env, id);
    }
  }
  if (pinned !== undefined) {
    await env.DB.prepare("UPDATE videos SET pinned = ? WHERE id = ?").bind(pinned, id).run();
  }
  return getVideo(env, id);
}

/* ---- settings ---------------------------------------------------------- */

export async function readSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const map = Object.fromEntries((results || []).map((row) => [row.key, row.value]));
  return {
    siteName: map.site_name ?? DEFAULT_SETTINGS.site_name,
    telegramUrl: map.telegram_url ?? DEFAULT_SETTINGS.telegram_url,
    adBannerCode: map.ad_banner_code ?? DEFAULT_SETTINGS.ad_banner_code,
    adNativeCode: map.ad_native_code ?? DEFAULT_SETTINGS.ad_native_code,
    adSmartlinkUrl: map.ad_smartlink_url ?? DEFAULT_SETTINGS.ad_smartlink_url,
    adSmartlinkCode: map.ad_smartlink_code ?? DEFAULT_SETTINGS.ad_smartlink_code,
    botFeedUrl: map.bot_feed_url ?? ""
  };
}

export const SETTINGS_KEYS = {
  siteName: "site_name",
  telegramUrl: "telegram_url",
  adBannerCode: "ad_banner_code",
  adNativeCode: "ad_native_code",
  adSmartlinkUrl: "ad_smartlink_url",
  adSmartlinkCode: "ad_smartlink_code",
  botFeedUrl: "bot_feed_url"
};

/* Raw settings access for values the site keeps for itself (the catalogue
   sync stamp, for example) — they are not part of the public settings. */
export async function readRawSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? String(row.value || "") : "";
}

export async function writeRawSetting(env, key, value) {
  await env.DB
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .bind(key, String(value == null ? "" : value))
    .run();
}

export async function writeSettings(env, patch) {
  const statements = [];
  for (const [field, key] of Object.entries(SETTINGS_KEYS)) {
    if (!(field in patch)) continue;
    statements.push(
      env.DB
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        )
        .bind(key, patch[field])
    );
  }
  if (statements.length) await env.DB.batch(statements);
  return readSettings(env);
}
