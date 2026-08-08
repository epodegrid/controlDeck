-- Lets several registry entries share one model backend.
--
-- A single container image commonly serves more than one name: llama-swap's
-- config gives a model aliases, and the fleet's images expose variants like
-- `ornith` and `ornith:thinking-coding` from the same loaded weights. Those
-- deserve to be separate entries in the gateway — different system prompt,
-- different cost, different capabilities advertised to callers — but they must
-- not each get their own Deployment, because that would mean two copies of a
-- 35B model resident for what the backend serves from one.
--
-- backend_model_id names the entry that owns the workload. It is NULL for the
-- ordinary case, where a model is its own backend.
--
-- This is what `replicas` are keyed by. Without it, two entries discovering the
-- same pod would fight over one row (the pod name is the replica id), flipping
-- its model_id back and forth every reconcile pass, and in_flight — the whole
-- basis of least-loaded placement — would be counted per alias instead of per
-- pod, letting the router hand out slots that do not exist.

ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS backend_model_id TEXT;
