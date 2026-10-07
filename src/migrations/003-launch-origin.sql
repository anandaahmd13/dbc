-- Where a launch came from. 'live' = seen as it happened, so any order we later
-- read is necessarily new; 'backfill' = launched before we watched, so an
-- existing order may predate us and must be recorded silently first.
ALTER TABLE launches ADD COLUMN origin TEXT NOT NULL DEFAULT 'live';
