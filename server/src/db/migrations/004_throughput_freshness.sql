-- When a replica's throughput was last measured.
--
-- Placement prefers faster replicas among equally-loaded ones. Without a
-- freshness stamp that preference is self-reinforcing: a replica that records
-- one slow period ranks last, so it stops receiving requests, so it never
-- records a newer measurement, so it ranks last forever. Observed in testing —
-- a replica throttled and then restored received zero traffic afterwards while
-- reporting healthy.
--
-- With this, a measurement older than the freshness window is treated as
-- unknown rather than as fact, and an unknown replica is tried first. A replica
-- that has been idle long enough is therefore always re-explored, and one that
-- has genuinely recovered earns its score back.

ALTER TABLE replicas ADD COLUMN IF NOT EXISTS tokens_per_sec_at TIMESTAMPTZ;

-- Existing measurements have no recorded time; treat them as fresh now rather
-- than stale, so an upgrade doesn't stampede every replica into re-exploration.
UPDATE replicas SET tokens_per_sec_at = now() WHERE tokens_per_sec IS NOT NULL AND tokens_per_sec_at IS NULL;
