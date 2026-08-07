-- Per-replica endpoint + liveness bookkeeping.
--
-- Placement chose a replica but the router then sent the request to the
-- model-level endpoint_url, so every replica of a model received traffic at
-- the same address: least-loaded selection was real in the database and
-- fictional on the wire. A replica needs its own address for the balancing to
-- mean anything.
--
-- `last_seen_at` lets the reconciler distinguish "reported unhealthy just now"
-- from "has not been observed at all recently".

ALTER TABLE replicas ADD COLUMN IF NOT EXISTS endpoint_url TEXT NOT NULL DEFAULT '';
ALTER TABLE replicas ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
