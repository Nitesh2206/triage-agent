-- Phase 5: retention purge (threat-model prerequisite — lands before any real
-- mailbox connects), plus columns for rerun idempotency and send idempotency.

-- Rerun idempotency marker: the live runner selects untriaged rows only, so a
-- cursor replay or crash between ingest and triage never re-triages a message.
alter table messages add column triaged_at timestamptz;

-- Send idempotency (phase-5 Gmail sender): we author the RFC 5322 Message-ID,
-- persist it before calling Gmail, and recover stuck 'sending' rows by
-- searching for it (rfc822msgid:). gmail_message_id records the provider's id
-- of the sent message for the audit trail.
alter table approvals add column send_message_id text;
alter table approvals add column gmail_message_id text;
-- When the current send attempt started — the recovery hold window measures
-- from here (decided_at can be arbitrarily older than the first attempt).
alter table approvals add column sending_at timestamptz;

-- Retention deletes cascade: a purged message takes its drafts and approvals
-- with it. (0002/0003 created these FKs without cascade.)
alter table drafts
  drop constraint drafts_provider_provider_message_id_fkey,
  add constraint drafts_provider_provider_message_id_fkey
    foreign key (provider, provider_message_id)
    references messages (provider, provider_message_id) on delete cascade;
alter table approvals
  drop constraint approvals_draft_id_fkey,
  add constraint approvals_draft_id_fkey
    foreign key (draft_id) references drafts (id) on delete cascade;

create index messages_received_at_idx on messages (received_at);

-- Purge everything older than the retention window. audit_log and costs rows
-- are matched on the (provider, providerMessageId) pairs of the purged
-- messages AND their own row age — never on the JSON message id alone — so an
-- id collision or a recent row about an old message cannot widen the delete.
-- Hardened: security definer with empty search_path (every reference schema-
-- qualified), execute revoked below — callable only via service-role RPC.
create function purge_expired(retention interval)
returns table (messages_deleted bigint, audit_deleted bigint, costs_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz := now() - retention;
begin
  delete from public.costs c
    using public.messages m
    where m.received_at < cutoff
      and c.provider = m.provider
      and c.provider_message_id = m.provider_message_id
      and c.at < cutoff;
  get diagnostics costs_deleted = row_count;

  delete from public.audit_log a
    using public.messages m
    where m.received_at < cutoff
      and a.detail ->> 'provider' = m.provider
      and a.detail ->> 'providerMessageId' = m.provider_message_id
      and a.at < cutoff;
  get diagnostics audit_deleted = row_count;

  -- Last: cascades drafts and approvals.
  delete from public.messages where received_at < cutoff;
  get diagnostics messages_deleted = row_count;

  return next;
end;
$$;

revoke all on function purge_expired(interval) from public, anon, authenticated;
grant execute on function purge_expired(interval) to service_role;
