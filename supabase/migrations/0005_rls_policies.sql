-- Phase 5: dashboard authentication support — operator allowlist + the
-- deliberately narrow read policies deferred from phase 4.
--
-- Shape: SELECT-only, and only for authenticated users on the operator
-- allowlist. No insert/update/delete policies exist on any table — every
-- state transition (approve, claim, send, purge) goes through the service
-- role in server code, so a leaked anon key + session cannot drive the
-- approval lifecycle. A blanket `to authenticated using (true)` would have
-- exposed every sensitive row to any signed-up user; the allowlist gate is
-- the whole point.

-- Operator allowlist. Service-role managed (RLS on, no policies): rows are
-- seeded by hand in the SQL editor, never from the dashboard.
create table operators (
  email text primary key,
  added_at timestamptz not null default now()
);
alter table operators enable row level security;

-- stable: result can be cached within a statement; empty search_path +
-- security definer so the check works for the authenticated role without
-- granting it direct access to operators.
create function is_operator() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.operators
    where email = (select auth.jwt() ->> 'email')
  );
$$;

revoke all on function is_operator() from public, anon;
grant execute on function is_operator() to authenticated;

create policy operator_read on messages   for select to authenticated using (is_operator());
create policy operator_read on drafts     for select to authenticated using (is_operator());
create policy operator_read on approvals  for select to authenticated using (is_operator());
create policy operator_read on audit_log  for select to authenticated using (is_operator());
create policy operator_read on costs      for select to authenticated using (is_operator());
