-- Collapse stray global logging rows onto the single key that is read.
--
-- The global content-logging scope is keyed by the empty string, and
-- isContentLoggingEnabled looks for exactly that. The audit page wrote
-- ("global", "global") instead, which persisted, displayed as on, and gated
-- nothing — while the settings page wrote the real row, so the two disagreed
-- about the same setting.
--
-- Any stray row wins if it was enabled: an operator who turned content logging
-- on and saw it stay on should not have it silently turn off on upgrade.

UPDATE audit_logging_config
SET enabled = true
WHERE scope_type = 'global'
  AND scope_key = ''
  AND EXISTS (
    SELECT 1 FROM audit_logging_config stray
    WHERE stray.scope_type = 'global' AND stray.scope_key <> '' AND stray.enabled
  );

INSERT INTO audit_logging_config (scope_type, scope_key, enabled)
SELECT 'global', '', bool_or(enabled)
FROM audit_logging_config
WHERE scope_type = 'global' AND scope_key <> ''
HAVING count(*) > 0
ON CONFLICT (scope_type, scope_key) DO NOTHING;

DELETE FROM audit_logging_config WHERE scope_type = 'global' AND scope_key <> '';
