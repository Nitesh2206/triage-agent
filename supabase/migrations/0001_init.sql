-- Phase 1 schema: messages, audit_log, costs.
-- Idempotency is enforced here, not in application code: the unique constraint
-- on (provider, provider_message_id) cannot race; check-then-insert can.

create table messages (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_message_id text not null,
  from_address text not null,
  from_display_name text,
  to_addresses text[] not null default '{}',
  subject text not null,
  received_at timestamptz not null,
  body text not null,
  auth_results text,
  ingested_at timestamptz not null default now(),
  unique (provider, provider_message_id)
);

-- Every tool call, refusal, and decision. Written by the MCP server (phase 2+).
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  message_id bigint references messages (id),
  actor text not null,          -- 'agent' | 'human' | 'system'
  action text not null,         -- tool name or event type
  allowed boolean not null,
  trust_tier smallint,
  detail jsonb not null default '{}'
);

-- Per-stage token spend. Written by the agent loop (phase 3+).
create table costs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  message_id bigint references messages (id),
  stage text not null,          -- 'classify' | 'draft' | 'eval'
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  usd numeric(10, 6) not null
);
