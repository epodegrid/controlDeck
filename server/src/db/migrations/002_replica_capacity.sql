-- Per-replica concurrency ceiling.
--
-- PRD §6.4 says "route to the least-loaded ready replica; if none are free,
-- route to queue" — which requires a notion of a replica being *full*.
-- Without one, placement always found a 'ready' replica, never returned
-- needsQueue, and the queue-wait timeout in §6.5 was unreachable. The router
-- also overcommitted real backends, which reject the excess.
--
-- Default 1 is the conservative choice for a GPU-bound llama-swap replica
-- serving one generation at a time. Raise it per replica for backends that
-- genuinely handle parallel work (embeddings, for example).

ALTER TABLE replicas ADD COLUMN IF NOT EXISTS max_concurrency INT NOT NULL DEFAULT 1;

DO $$
BEGIN
  ALTER TABLE replicas ADD CONSTRAINT replicas_max_concurrency_positive CHECK (max_concurrency >= 1);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
