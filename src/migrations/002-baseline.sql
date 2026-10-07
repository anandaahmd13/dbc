-- Per-launch flag: has the silent baseline pass (orders + socials) been recorded?
-- Alerts are only emitted for changes seen AFTER the baseline.
ALTER TABLE launches ADD COLUMN baseline_done INTEGER NOT NULL DEFAULT 0;
