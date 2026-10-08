-- Launches recorded before creator verification was asynchronous were marked
-- eligible=1 on the strength of a cached verdict that migration 004 then reset to
-- 'unknown' (it was computed without counting the launch itself). Their alerts
-- were therefore going out unverified. Put every still-monitored launch whose
-- creator is not currently proven eligible back into the verification queue:
-- monitoring continues, alerts are held, and the creator worker re-proves them.
UPDATE launches
SET pending_creator = 1,
    eligible = 0,
    creator_attempts = 0,
    creator_next_check_at = 0
WHERE watch_until > CAST(strftime('%s','now') AS INTEGER) * 1000
  AND eligible = 1
  AND NOT EXISTS (
    SELECT 1 FROM creators c WHERE c.address = launches.creator AND c.eligibility = 'eligible'
  );
