-- Fields needed to talk to a real llama-swap model container.
--
-- upstream_model
--   llama-swap chooses which process to proxy to from the `model` field in
--   the request body — that is its entire routing mechanism. The gateway's own
--   model id is a platform-level name ("eve", "ornith-35b") and need not match
--   the name the container answers to, or the variant aliases it exposes
--   (`eve:thinking-coding`). Without this the two are forced to be identical.
--
-- port
--   Not every backend listens on 8080. A llama-swap container does; a
--   purpose-built embedding service may not — the one in this fleet serves
--   FastAPI on 8000. Hard-coding the port made those unreachable.
--
-- first_token_timeout_ms
--   PRD §6.5's stall clock is explicitly "once generation has started". A
--   llama-swap container loads model weights on the first request and holds
--   the connection while it does, which for a 35B GGUF over several shards is
--   minutes. Measuring that against the 60s inactivity threshold kills exactly
--   the requests that are working correctly, so the wait for a first token
--   gets its own, much longer allowance.

ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS upstream_model TEXT;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS port INT NOT NULL DEFAULT 8080;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS first_token_timeout_ms INT;

-- Distinguishes "waiting for the first token" from "was generating and
-- stopped", so the two clocks can be swept independently.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS first_token_at TIMESTAMPTZ;
