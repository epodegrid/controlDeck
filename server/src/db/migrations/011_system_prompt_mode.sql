-- How a model's backend wants the system prompt delivered.
--
-- Not every chat template has a system role. Gemma's does not: its template
-- knows only user and model turns, so a system message either raises an error
-- or is silently dropped depending on the build. The symptom is a model that
-- ignores its instructions entirely while every layer above reports success —
-- the gateway forwards the message, llama.cpp accepts the request, and the
-- prompt simply never reaches the weights.
--
-- 'passthrough' (the default) sends the message as the caller wrote it.
-- 'merge' folds it into the first user turn, which is how such templates are
-- conventionally fed a system prompt.

ALTER TABLE model_registry
  ADD COLUMN IF NOT EXISTS system_prompt_mode TEXT NOT NULL DEFAULT 'passthrough'
  CHECK (system_prompt_mode IN ('passthrough', 'merge'));
