# Build plan

Working document: phases, tasks, acceptance bars. Check things off as they land; when reality diverges from plan, update the plan. Architecture and rationale live in [`architecture.md`](architecture.md).

## How we work

- Each phase ends with a working system and green checks — never a half-wired layer
- Commit per meaningful step; the history should read as the build story
- Security and eval infrastructure land *before* the features they guard

## Prerequisites

- [x] Node LTS + pnpm
- [ ] Supabase project (free tier) — needed from phase 4 (dashboard) / phase 5 (live)
- [ ] Anthropic API key — needed from phase 3
- [ ] Google AI Studio key (free) — dev loop and eval judging, phase 3
- [ ] Trello workspace + API key — phase 2 (live card creation can be stubbed until then)
- [ ] Gmail OAuth credentials — phase 5 only
- [ ] GitHub repo + Actions enabled

## Phase 1 — Skeleton + fixture ingest ✅ (done)

- [x] pnpm monorepo: `@triage/core`, `@triage/ingestor`, shared tsconfig/eslint/prettier/vitest
- [x] Core types: `TriageMessage`, `TrustTier`, `Category`; `MailProvider`, `MessageStore` interfaces
- [x] `FixtureProvider` + 10 labeled training-org fixtures (incl. 2 injection attacks)
- [x] `MemoryStore` (tests/demo) + `SupabaseStore` (constraint-based idempotency)
- [x] Migration 0001: `messages`, `audit_log`, `costs`
- [x] CI: build + lint + test
- [x] **Accept:** `pnpm demo:ingest` loads fixtures; rerun inserts zero

## Phase 1.5 — Review remediation ✅ (done)

External review of phase 1; accepted findings applied:

- [x] RLS enabled on all tables (no policies; service role only until dashboard)
- [x] Sync contract redesigned: `sync(cursor?) → { messages, nextCursor }` + `CursorExpiredError`; `sync_state` table added
- [x] Epoch-based timestamp comparison (lexicographic ISO compare was a bug)
- [x] Envelope extended: `providerThreadId`, `cc`, `inReplyTo`, `headerReferences` — required for thread-scoped drafting
- [x] `SupabaseStore` error mapping unit-tested via injected stub client
- [x] `threat-model.md` written (incl. retention, secrets, access control)
- Deferred: live Supabase integration test → phase 5 (when the live path exists). Rejected: concurrent-duplicate test (exercises Postgres's constraint guarantee, not our code).

## Phase 2 — Guarded MCP server (no LLM yet) ✅ (done)

- [x] `@triage/mcp-server`: tools `email_apply_label`, `email_draft_reply`, `trello_create_card`, `triage_escalate`, `triage_log_decision` (underscores — MCP tool names disallow dots)
- [x] `@triage/store` extracted (ingestor and mcp-server both need persistence; interfaces stay in core)
- [x] Trust-tier resolution from provider-normalized DMARC + domain alignment (fail closed on missing/invalid evidence; display name never consulted)
- [x] Fail-closed two-phase audit middleware: authorization row before execution (audit write failure blocks the tool), outcome row after; refusals return `isError` + stable `POLICY_DENIED` / `UNKNOWN_MESSAGE` codes
- [x] Audit details sanitized: references and lengths only, draft text lives in the `drafts` staging table (migration 0002)
- [x] Tests: full 3×5 tier×tool matrix, denied-handler-never-executes, audit-failure-blocks-execution, unknown-message, handler-error, sanitization, 7 trust-resolution cases
- [x] **Accept:** `pnpm demo:mcp` — tier-0 refused `email_draft_reply` with audited refusal; tier-1/2 allowed; unknown id audited as attempt

## Phase 3 — Agent loop + quarantine + classification

- [ ] `@triage/agent`: `LLMProvider` interface, `claude` (Agent SDK) + `gemini` implementations
- [ ] Quarantine wrapper: per-message delimited untrusted block; extraction pass = structured output only, zero tools
- [ ] Classification (small model), suspicion flags, per-message token budget hard cap
- [ ] Eval harness `evals/run.ts`: classification suite (precision/recall, ~60 fixtures — grow fixture set) and injection suite (100% pass gate)
- [ ] CI: 10-fixture smoke subset; full suite on demand
- [ ] **Accept:** `pnpm demo` classifies all fixtures end-to-end through MCP tools; injection suite 100%

## Phase 4 — Drafting + approval queue + dashboard

- [ ] Draft generation (stronger model; tier 2 only; scope limited to source thread)
- [ ] `approvals` table + queue worker — send happens only post-approval, agent has no send tool
- [ ] `@triage/dashboard` (Next.js): queue with approve/edit/reject, audit log incl. blocked calls, cost table
- [ ] Deliberate RLS policies for dashboard reads
- [ ] **Accept:** fixture email → draft → approve on dashboard → simulated send recorded

## Phase 5 — Live Gmail + deployment

- [ ] `GmailProvider`: OAuth, historyId cursor via `sync_state`, expiry → full resync, retry/backoff
- [ ] Cursor persistence: store page first, advance cursor after — replay-safe by idempotency
- [ ] Live Supabase integration test (insert, duplicate, count, error propagation) in CI
- [ ] Retention/deletion job per threat model
- [ ] Deploy: ingestor+agent on GitHub Actions cron; dashboard on Vercel
- [ ] **Accept:** real test inbox triaged live; per-stage costs visible on dashboard

## Phase 6 — Roadmap (unscheduled)

GraphProvider (Microsoft 365) · LLM-as-judge draft-quality suite (cross-vendor judge) · Gmail push/Pub-Sub ingestion · MCP HTTP transport · eval trend charts
