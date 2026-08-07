-- Core schema per PRD §7 Data Model

CREATE TABLE IF NOT EXISTS model_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  class_label TEXT NOT NULL,
  model_class TEXT NOT NULL CHECK (model_class IN ('large', 'fast', 'vision', 'embedding')),
  capabilities TEXT[] NOT NULL,
  min_replicas INT NOT NULL DEFAULT 1,
  max_replicas INT NOT NULL DEFAULT 1,
  system_prompt TEXT NOT NULL DEFAULT '',
  cost_value NUMERIC NOT NULL DEFAULT 0,
  cost_basis TEXT NOT NULL DEFAULT 'per_1k_tokens' CHECK (cost_basis IN ('per_1k_tokens', 'per_request', 'per_compute_second')),
  endpoint_url TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard-made edits, merged on top of the GitOps/Helm base config at read time.
-- Never mutate model_registry rows that originated from a Helm-managed deploy directly.
CREATE TABLE IF NOT EXISTS model_registry_overrides (
  model_id TEXT PRIMARY KEY REFERENCES model_registry(id) ON DELETE CASCADE,
  fields JSONB NOT NULL DEFAULT '{}',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_cost_config (
  model_id TEXT PRIMARY KEY REFERENCES model_registry(id) ON DELETE CASCADE,
  cost_value NUMERIC NOT NULL,
  cost_basis TEXT NOT NULL CHECK (cost_basis IN ('per_1k_tokens', 'per_request', 'per_compute_second')),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shared cross-instance in-flight/queue state (HA requirement, PRD §8)
CREATE TABLE IF NOT EXISTS replicas (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES model_registry(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ready', 'loading', 'busy', 'idle', 'error')),
  in_flight INT NOT NULL DEFAULT 0,
  load_pct NUMERIC NOT NULL DEFAULT 0,
  tokens_per_sec NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  caller_oid TEXT NOT NULL,
  caller_name TEXT NOT NULL,
  team TEXT,
  requested_model TEXT,
  routed_model TEXT,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'routed', 'streaming', 'completed',
    'queue_timeout', 'stall_timeout', 'replica_unavailable',
    'capability_mismatch', 'auth_invalid', 'error'
  )),
  error_code TEXT,
  replica_id TEXT,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_token_at TIMESTAMPTZ,
  duration_ms INT,
  cost_usd NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_arrived_at ON requests(arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_caller ON requests(caller_oid);

-- Full prompt/response content, only populated when logging is enabled for the request's scope.
CREATE TABLE IF NOT EXISTS audit_content (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  prompt TEXT,
  response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Content-logging toggles at global/team/model/key granularity (all can be active simultaneously).
CREATE TABLE IF NOT EXISTS audit_logging_config (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'team', 'model', 'key')),
  scope_key TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (scope_type, scope_key)
);

INSERT INTO audit_logging_config (scope_type, scope_key, enabled)
VALUES ('global', '', false)
ON CONFLICT DO NOTHING;
