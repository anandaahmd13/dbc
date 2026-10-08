-- Monitoring queues: per-launch poll schedule, full-info fingerprint, durable
-- order-check jobs, and a stable orders identity.

-- Snapshot gains the pieces of the DEX Screener profile that identify "full
-- info" (icon, header) plus a canonical fingerprint over everything stable.
ALTER TABLE token_snapshots ADD COLUMN image_url TEXT;
ALTER TABLE token_snapshots ADD COLUMN header_url TEXT;
ALTER TABLE token_snapshots ADD COLUMN info_fingerprint TEXT;
-- A change that REMOVES links/images is only applied once seen twice in a row,
-- so one thin/partial DEX Screener response never reads as "the dev deleted it".
ALTER TABLE token_snapshots ADD COLUMN pending_fingerprint TEXT;

-- Per-launch schedule, so a restart does not forget what is due.
ALTER TABLE launches ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE launches ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0;

-- Creator verification is now asynchronous. pending_creator=1 means the creator's
-- launch count is not yet proven: the token is still monitored, but its alerts are
-- held in the outbox until the verdict arrives (eligible -> release, else drop).
ALTER TABLE launches ADD COLUMN pending_creator INTEGER NOT NULL DEFAULT 0;
ALTER TABLE launches ADD COLUMN creator_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE launches ADD COLUMN creator_next_check_at INTEGER NOT NULL DEFAULT 0;

-- Orders are checked only when a token's profile appears/changes. One job per
-- mint; deadline bounds the retries while indexing catches up.
CREATE TABLE IF NOT EXISTS order_checks (
  base_mint        TEXT PRIMARY KEY,
  reason           TEXT NOT NULL,                 -- 'info_appeared' | 'info_changed' | 'baseline_info'
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | done | expired
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  deadline_at      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_checks_due ON order_checks (status, next_attempt_at);

-- Index for the per-loop "which launches are active/due" queries.
CREATE INDEX IF NOT EXISTS idx_launches_active ON launches (eligible, watch_until, next_poll_at);

-- orders.payment_ts was part of the primary key but nullable; SQLite treats NULLs
-- as distinct, so ON CONFLICT never fired and rows without a timestamp piled up.
-- Rebuild with payment_ts NOT NULL DEFAULT 0 (the application already keys on
-- `payment_ts ?? 0`), keeping the most recent row per identity.
CREATE TABLE orders_new (
  base_mint      TEXT NOT NULL,
  order_type     TEXT NOT NULL,
  status         TEXT NOT NULL,
  payment_ts     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (base_mint, order_type, payment_ts)
);
INSERT INTO orders_new (base_mint, order_type, status, payment_ts, updated_at)
SELECT o.base_mint, o.order_type, o.status, COALESCE(o.payment_ts, 0), o.updated_at
FROM orders o
WHERE o.rowid = (
  SELECT o2.rowid FROM orders o2
  WHERE o2.base_mint = o.base_mint
    AND o2.order_type = o.order_type
    AND COALESCE(o2.payment_ts, 0) = COALESCE(o.payment_ts, 0)
  ORDER BY o2.updated_at DESC, o2.rowid DESC
  LIMIT 1
);
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Legacy creator verdicts were cached forever and counted 0 for a creator who had
-- only just launched. Do not trust them: force a re-verification. A proven
-- 'ineligible' verdict is a lower bound (launches never un-happen) and is kept.
UPDATE creators SET checked_at = 0, launch_count = NULL, eligibility = 'unknown'
WHERE eligibility != 'ineligible';

-- Alerts for a launch whose creator is not yet proven are parked, not dropped:
-- status 'held' is skipped by the sender and released (-> 'pending') or discarded
-- (-> 'dropped') when the verdict arrives. base_mint ties a held message to its launch.
ALTER TABLE outbox ADD COLUMN base_mint TEXT;
ALTER TABLE outbox ADD COLUMN hold_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_outbox_held ON outbox (status, base_mint);
