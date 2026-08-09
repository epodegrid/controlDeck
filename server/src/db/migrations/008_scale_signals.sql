-- Preemptive scale-up intent, shared across router replicas.
--
-- §6.4 asks for a warm spare: the moment a replica takes its first request,
-- ask for one more in parallel rather than waiting for saturation. That intent
-- was held in a per-process Map, which is wrong the moment the router runs
-- more than one replica — and §8 requires it to. KEDA polls the router
-- *Service*, so with two replicas the poll reaches the pod holding the signal
-- roughly half the time and the spare is requested or not by coin flip.
--
-- It only shows up in the case the feature exists for: in_flight and queued
-- already come from Postgres, so once there is measurable demand the spare is
-- added regardless. The flag matters precisely when demand is still zero,
-- which is the moment preemptive scaling is supposed to act.

CREATE TABLE IF NOT EXISTS scale_signals (
  model_id     TEXT PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
