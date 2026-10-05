-- Audit trail for the scheduling pipeline.
-- Lives in the same PostgreSQL instance as n8n's own execution logs.
CREATE TABLE IF NOT EXISTS scheduling_audit (
    id             BIGSERIAL PRIMARY KEY,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    chat_id        TEXT,
    message_id     TEXT,
    status         TEXT NOT NULL,   -- created | modified | cancelled | conflict | discarded | entity_failed | invalid_command | event_not_found | calendar_error
    intent         TEXT,
    latency_ms     INTEGER,         -- webhook receipt -> calendar confirmation
    stage3_attempts INTEGER,
    payload        JSONB            -- stage outputs (message text only if logMessageText = true)
);
CREATE INDEX IF NOT EXISTS scheduling_audit_created_idx ON scheduling_audit (created_at);
CREATE INDEX IF NOT EXISTS scheduling_audit_status_idx  ON scheduling_audit (status);

-- Events waiting for the owner's ✅ / ❌ in Telegram (confirmation flow).
CREATE TABLE IF NOT EXISTS pending_actions (
    id          BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | skipped
    chat_id     TEXT,
    ctx         JSONB NOT NULL                     -- full pipeline context, replayed on approval
);
