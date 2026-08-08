-- Prefix-cache affinity: which replica already holds a conversation's KV cache.
--
-- ik_llama.cpp and llama.cpp keep a per-slot KV cache and reuse whatever
-- prefix a new request shares with it — that is what "selected slot by LCP
-- similarity" means in their logs. The saving is large: a long conversation
-- carries tens of thousands of prompt tokens, and a miss reprocesses all of
-- them before generating a single new token.
--
-- Within one pod the model server already picks the best slot. Across pods
-- nothing did, so successive turns of the same conversation landed on
-- whichever replica happened to be least loaded and paid full prompt-eval
-- every time. This table is what lets the router send a turn back to the pod
-- that can actually reuse the cache.
--
-- Shared state rather than per-instance memory, for the same reason in-flight
-- counts are (§8): with several router replicas, an affinity only one of them
-- knows about is worse than none, because turns alternate between routers.

CREATE TABLE IF NOT EXISTS replica_affinity (
  -- Hash of caller + model + the conversation's opening messages. Stable
  -- across the turns of one conversation, distinct between conversations, and
  -- carrying no prompt content itself.
  affinity_key TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sweeping expired rows scans by age.
CREATE INDEX IF NOT EXISTS idx_replica_affinity_last_used ON replica_affinity(last_used_at);

-- Lets a scaled-down replica's affinities be dropped in one statement.
CREATE INDEX IF NOT EXISTS idx_replica_affinity_replica ON replica_affinity(replica_id);

-- Records whether a request actually landed on its affine replica, so the
-- benefit is measurable rather than assumed.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS affinity_hit BOOLEAN;
