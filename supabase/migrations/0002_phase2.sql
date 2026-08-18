-- Phase 2: normalized authentication evidence, draft staging.

-- Replace the raw auth_results string with provider-normalized DMARC evidence.
-- Trust tiers derive from dmarc + aligned_domain; the raw header is audit/debug only.
alter table messages drop column auth_results;
alter table messages add column dmarc text;            -- 'pass' | 'fail' | 'none'
alter table messages add column aligned_domain text;
alter table messages add column auth_results_raw text;

-- Reply drafts staged for human approval (phase 4 builds the queue on top).
-- Draft text lives here, never in audit_log — audit rows carry references only.
create table drafts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  provider text not null,
  provider_message_id text not null,
  body text not null,
  foreign key (provider, provider_message_id)
    references messages (provider, provider_message_id)
);

alter table drafts enable row level security;
