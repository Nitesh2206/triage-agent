-- Phase 4: human approval queue over staged drafts; costs keyed like every
-- other table.

-- CostLog keys entries by (provider, provider_message_id) — align the table
-- with the interface instead of resolving messages.id on every write.
alter table costs add column provider text;
alter table costs add column provider_message_id text;

-- Lifecycle: pending -> approved|rejected; approved -> sending -> sent.
-- 'sending' is the atomic claim state (conditional update from 'approved'),
-- so concurrent workers cannot send the same draft twice. A row stuck in
-- 'sending' means a crash between send and mark-sent — surfaced on the
-- dashboard for a human to resolve; never auto-retried in phase 4.
create table approvals (
  id bigint generated always as identity primary key,
  draft_id bigint not null unique references drafts (id),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'sending', 'sent')),
  edited_body text,
  decided_by text,
  decided_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- Every draft gets its approval row atomically: same transaction as the draft
-- insert, so a draft can never exist without a pending review.
create function create_pending_approval() returns trigger
language plpgsql as $$
begin
  insert into approvals (draft_id) values (new.id);
  return new;
end;
$$;

create trigger drafts_create_pending_approval
  after insert on drafts
  for each row execute function create_pending_approval();

-- RLS enabled, deliberately NO policies: phase 4 dashboard runs locally on the
-- service role only. Scoped read policies land in phase 5 together with real
-- dashboard authentication — anon/authenticated must see nothing until then.
alter table approvals enable row level security;
