-- Single-process tracker schema. All timestamps are unix epoch ms.

-- One row per creator wallet we have evaluated.
CREATE TABLE IF NOT EXISTS creators (
  address        TEXT PRIMARY KEY,
  launch_count   INTEGER,                 -- proven count, NULL while unknown
  eligibility    TEXT NOT NULL DEFAULT 'unknown', -- 'eligible' | 'ineligible' | 'unknown'
  checked_at     INTEGER,                 -- last time history was evaluated
  created_at     INTEGER NOT NULL
);

-- One row per DBC pool / launch we have seen.
CREATE TABLE IF NOT EXISTS launches (
  pool           TEXT PRIMARY KEY,
  base_mint      TEXT NOT NULL,
  creator        TEXT NOT NULL,
  signature      TEXT,                    -- tx that created/surfaced the pool
  detected_at    INTEGER NOT NULL,
  watch_until    INTEGER NOT NULL,        -- stop polling DEX Screener after this
  eligible       INTEGER NOT NULL DEFAULT 0, -- snapshot of eligibility at tracking time
  UNIQUE (base_mint)
);
CREATE INDEX IF NOT EXISTS idx_launches_mint ON launches (base_mint);
CREATE INDEX IF NOT EXISTS idx_launches_creator ON launches (creator);
CREATE INDEX IF NOT EXISTS idx_launches_watch ON launches (watch_until);

-- Latest known DEX Screener social/profile snapshot per mint (baseline + current).
CREATE TABLE IF NOT EXISTS token_snapshots (
  base_mint      TEXT PRIMARY KEY,
  websites_json  TEXT NOT NULL DEFAULT '[]', -- normalized sorted JSON array
  socials_json   TEXT NOT NULL DEFAULT '[]', -- normalized sorted JSON array of {type,url}
  has_info       INTEGER NOT NULL DEFAULT 0,  -- whether DEX Screener returned an info block
  updated_at     INTEGER NOT NULL
);

-- Latest known paid-order state per (mint, order type).
CREATE TABLE IF NOT EXISTS orders (
  base_mint      TEXT NOT NULL,
  order_type     TEXT NOT NULL,           -- e.g. 'tokenProfile'
  status         TEXT NOT NULL,           -- processing|approved|on-hold|cancelled|rejected
  payment_ts     INTEGER,                 -- paymentTimestamp from API, if any
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (base_mint, order_type, payment_ts)
);

-- Dedup log of emitted events so we never enqueue the same alert twice.
CREATE TABLE IF NOT EXISTS events (
  event_key      TEXT PRIMARY KEY,        -- deterministic hash of the event
  base_mint      TEXT NOT NULL,
  kind           TEXT NOT NULL,           -- 'launch'|'order'|'social'
  created_at     INTEGER NOT NULL
);

-- Durable cursors (e.g. last processed launch signature).
CREATE TABLE IF NOT EXISTS cursors (
  name           TEXT PRIMARY KEY,
  value          TEXT,
  updated_at     INTEGER NOT NULL
);

-- Telegram notification outbox (at-least-once delivery).
CREATE TABLE IF NOT EXISTS outbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key      TEXT NOT NULL UNIQUE,    -- ties a message to its source event
  text           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  sent_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, next_attempt_at);
