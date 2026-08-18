# Build plan

Working document: phases, tasks, acceptance bars. Check things off as they land; when reality diverges from plan, update the plan and log why in [`what-broke.md`](what-broke.md). Architecture and rationale live in [`architecture.md`](architecture.md).

## How we work

- Each phase ends with a working system and green checks — never a half-wired layer
- Commit per meaningful step; the history should read as the build story
- Failures and wrong assumptions get logged in `what-broke.md` as they happen, not retrospectively polished
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
- [x] `threat-model.md` (incl. retention, secrets, access control) and `what-broke.md` written
- Deferred: live Supabase integration test → phase 5 (when the live path exists). Rejected: concurrent-duplicate test (exercises Postgres's constraint guarantee, not our code).

## Phase 2 — Guarded MCP server (no LLM yet)

- [ ] `@triage/mcp-server`: tools `email.apply_label`, `email.draft_reply`, `trello.create_card`, `triage.escalate`, `triage.log_decision`
- [ ] Trust-tier resolution from verified domain + auth results (never display name)
- [ ] Middleware: per-call tier check, refusals logged, never thrown away silently
- [ ] Audit logging middleware → `audit_log` (args, result, tier, tokens)
- [ ] Unit tests: full tier × tool matrix, refusal paths, spoofed-sender cases
- [ ] **Accept:** MCP inspector session shows tier-0 sender refused `draft_reply`; audit rows written

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
