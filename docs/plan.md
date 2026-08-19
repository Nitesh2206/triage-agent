# Build plan

Working document: phases, tasks, acceptance bars. Check things off as they land; when reality diverges from plan, update the plan. Architecture and rationale live in [`architecture.md`](architecture.md).

## How we work

- Each phase ends with a working system and green checks — never a half-wired layer
- Commit per meaningful step; the history should read as the build story
- Security and eval infrastructure land *before* the features they guard

## Prerequisites

- [x] Node LTS + pnpm (≥22.9 — demo/dashboard scripts use `--env-file-if-exists`)
- [x] Supabase project (free tier) — needed from phase 4 (dashboard) / phase 5 (live)
- [ ] Anthropic API key — needed from phase 3
- [x] Google AI Studio key (free) — dev loop and eval judging, phase 3
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

## Phase 3 — Agent loop + quarantine + classification ✅ (done)

- [x] `@triage/agent`: `LLMProvider` interface; `claude` + `gemini` + `fake` implementations. *Deviation: plain Messages API + explicit MCP client calls, not Agent SDK — classification has zero tools by design and code drives the tool calls; the SDK earns its place in phase 4 when drafting needs real agentic tool use. `fake` (keyword heuristic) keeps `pnpm demo` credential-free.*
- [x] Quarantine wrapper: per-message nonce-delimited untrusted block; extraction pass = structured output only, zero tools
- [x] Classification (Haiku / Gemini Flash), suspicion flags (any flag forces category `suspicious` in code), pre-flight estimated-token hard cap (kill before spend) + API max_tokens output kill + post-flight breach alert
- [x] Eval harness `evals/run.ts`: classification suite (precision/recall/macro-F1, reported not gated), injection suite (100% gate incl. audit-log scan for out-of-policy calls), benign false-positive gate ≤15%, chaos giant-body fixture. *Deviation: 31 fixtures not ~60 — enough for per-category stats; grow later.*
- [x] CI: 10-fixture smoke on push (Gemini secret, fails loudly if missing), full suite on `workflow_dispatch`; eval jobs never run on `pull_request` so the secret can't meet fork code
- [x] **Accept:** `pnpm demo` classifies all fixtures end-to-end through MCP tools; injection suite gated at 100%
- Deferred: durable `escalations` table (dashboard reads escalations from the audit log) · rerun idempotency operation key → phase 5 (phase-3 stores are fresh-per-run) · majority-vote accuracy gate → later (single-run too noisy). `SupabaseCostLog` was un-deferred in phase 4 — the cost dashboard consumes it.

## Phase 4 — Drafting + approval queue + dashboard ✅ (done)

- [x] Draft generation: `draftReply` on `LLMProvider` (claude → `claude-sonnet-5`, gemini → `gemini-3.5-flash`, fake → template); code gates in the loop — tier 2 AND draftable category (`enrolment_query`, `certificate_request`) AND not suspicious; MCP guard stays the enforcement authority. Budget covers classify+draft cumulatively; over-budget drafts skipped pre-flight with a refused audit row
- [x] Migration 0003: `approvals` (pending → approved|rejected; approved → sending → sent), created atomically with each draft by DB trigger; costs table gains (provider, provider_message_id)
- [x] Queue worker `processApprovals` — the only send path; audit authorization row persisted BEFORE the send (audit down = send blocked); atomic `claimForSend` (conditional update) prevents double-send; recipient/thread scope fixed in code to the source message; phase-4 sender is simulated. *Deviation: provider-side idempotency key deferred to phase 5's real Gmail sender.*
- [x] `@triage/dashboard` (Next.js 15): approval queue with approve/edit/reject (server actions run the worker inline), audit log incl. refusals, per-stage cost table; Supabase-backed via root `.env`. Decisions fail closed unless `TRIAGE_ALLOW_APPROVALS=1` (server-side env, never headers — spoofable); dev/start bind to 127.0.0.1
- [x] Eval draft gates (deterministic): zero drafts for attack fixtures; exactly one draft per tier-2 draftable benign fixture. LLM-judge draft-quality suite stays roadmap.
- [x] **Accept (verified live 2026-08-19):** fx-012 → Gemini classify → draft staged → approved on dashboard → simulated send with two-phase `email_send` audit rows, approval `sent`
- *Deviation (reviewed): RLS read policies NOT added — dashboard is local-only on the service role in phase 4; deliberate scoped policies land with real auth + deploy in phase 5. `authenticated using (true)` would have exposed every sensitive row.*
- *Note: gemini default model moved to `gemini-3.5-flash` — 2.5-generation models 404 for new accounts, and free-tier daily quota on retired models is tiny.*

## Phase 5 — Live Gmail + deployment

- [ ] `GmailProvider`: OAuth, historyId cursor via `sync_state`, expiry → full resync, retry/backoff
- [ ] Real `MailSender` (Gmail) with provider-side idempotency key; resolve In-Reply-To from the thread
- [ ] Dashboard auth + deliberate scoped RLS read policies (deferred from phase 4)
- [ ] Cursor persistence: store page first, advance cursor after — replay-safe by idempotency
- [ ] Live Supabase integration test (insert, duplicate, count, error propagation) in CI
- [ ] Retention/deletion job per threat model
- [ ] Deploy: ingestor+agent on GitHub Actions cron; dashboard on Vercel
- [ ] **Accept:** real test inbox triaged live; per-stage costs visible on dashboard

## Phase 6 — Roadmap (unscheduled)

GraphProvider (Microsoft 365) · LLM-as-judge draft-quality suite (cross-vendor judge) · Gmail push/Pub-Sub ingestion · MCP HTTP transport · eval trend charts
