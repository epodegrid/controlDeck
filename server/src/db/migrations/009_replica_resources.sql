-- Per-replica resource usage and restart count.
--
-- The monitoring view showed "—" for all three with the note "requires K8s
-- metrics API, not wired in this build". Two thirds of that was wrong:
--
--   restart_count   comes straight off the pod object the reconciler already
--                   fetches. No metrics API is involved. It is also the
--                   cheapest signal that a replica is unhealthy in a way
--                   readiness never shows — a model server OOM-killed
--                   mid-generation is Ready again moments later, and this
--                   number climbing is the only trace.
--
--   cpu / memory    do need metrics.k8s.io, which is an add-on rather than
--                   part of Kubernetes — but one AKS installs by default, so
--                   on the cluster this was built for the figures are there
--                   for the asking.
--
-- Nullable on purpose: a cluster without metrics-server has no CPU or memory
-- to report, and the dashboard should say that rather than print a zero that
-- reads as an idle replica.

ALTER TABLE replicas ADD COLUMN IF NOT EXISTS cpu_millicores NUMERIC;
ALTER TABLE replicas ADD COLUMN IF NOT EXISTS memory_bytes BIGINT;
ALTER TABLE replicas ADD COLUMN IF NOT EXISTS restart_count INT NOT NULL DEFAULT 0;
