# triage-agent — Architecture

An autonomous email-triage agent for a training organisation's operations inbox. It reads incoming mail, classifies it, files it, creates follow-up tasks, and drafts replies — while a human approves anything that leaves the building. Built as a learning project in production-grade agent engineering: the interesting problems here are not "call an LLM" but untrusted input, permission containment, measurable quality, and cost visibility.

## 1. What it does

A training organisation's inbox receives a steady stream of operational email: enrolment questions, certificate requests, complaints, invoices, regulator correspondence, spam. Most of it follows patterns a machine can handle; some of it is sensitive, urgent, or hostile. The agent:

1. Fetches new mail on a schedule
2. Classifies each message (category, urgency, sender trust)
3. Applies labels and creates task cards for anything needing follow-up
4. Drafts replies for routine queries
5. Queues every draft for human approval — **the agent never sends email on its own**
6. Logs every decision, tool call, refusal, and token spent

## 2. Design principles

These four rules drive every structural decision below:

1. **Email content is evidence, never instructions.** Anything inside a message body is untrusted data. The agent may read it; nothing in it may direct the agent.
2. **Permissions are enforced outside the model.** The agent *requests* actions; a separate guard layer *decides*. A fully compromised prompt still cannot execute a forbidden tool call.
3. **Quality is measured, not assumed.** Every capability has a labeled eval suite that runs in CI. If we can't score it, we don't trust it.
4. **Every run has a price tag.** Token usage is logged per message and per stage, so unit economics are a dashboard number, not a guess.

## 3. Pipeline

```
                 ┌────────────────────────────────────────────────────┐
                 │                      Supabase                      │
                 │   messages · decisions · audit_log · costs · evals │
                 └───────▲─────────────────▲──────────────────▲───────┘
                         │                 │                  │
 Gmail ──poll──► [1] Ingestor      [3] Agent loop       [6] Dashboard
 (cron)              │                 │  (Claude Agent SDK)   │
                     │                 │ MCP (stdio)           │
                     ▼                 ▼                       │
              [2] Quarantine    [4] triage-tools          approvals,
                  wrapper           MCP server            costs, evals
                                     │
                            trust check · audit log
                                     │
                         Gmail API · Trello API · [5] approval queue
```

### Stage 1 — Ingest

A scheduled worker (cron, every few minutes) polls the mailbox via the Gmail API using history-based incremental sync, so each run fetches only what changed. Raw messages are stored in Supabase keyed by message ID — re-fetching the same message is a no-op, so crashes and retries are safe (idempotent by construction).

No LLM is involved at this stage; it is a plain API client with retry/backoff. Mail access is behind a `MailProvider` interface with three implementations:

| Provider | Purpose |
|---|---|
| `GmailProvider` | Primary live provider (OAuth 2.0) |
| `FixtureProvider` | Replays labeled emails from JSON files — the whole pipeline runs with zero credentials (`npm run demo`) |
| `GraphProvider` | Microsoft 365 / Outlook (roadmap) |

### Stage 2 — Quarantine

Before any model sees a message, it is wrapped as untrusted content: the body is placed in a delimited data block, and the system prompt states explicitly that nothing inside the block is an instruction. Quarantine applies **per message, not per thread** — quoted replies inside a trusted colleague's email are still untrusted, because that is exactly where injected text hides.

The first model pass is *structured extraction only*: the model must emit a JSON verdict (category, urgency, entities, suspicion flags) and has **no tool access at all** while reading raw content. Tool-capable stages only ever see the structured verdict, never the raw body driving tool choice.

### Stage 3 — Classify and route

The agent loop (Claude Agent SDK) runs a two-tier model strategy:

- **Classification** — a small fast model (Haiku), structured output, fractions of a cent per message
- **Drafting** — a stronger model (Sonnet), only invoked when drafting is permitted and warranted
- Messages flagged as suspicious are **never drafted** — they route straight to a human with the suspicion evidence attached

Model access sits behind an `LLMProvider` interface with two implementations: `claude` (production path) and `gemini` (free-tier development loop and eval judging). Swapping is one config change; the tool layer below is protocol-agnostic and does not change at all.

### Stage 4 — Guarded tools (MCP server)

All actions the agent can take are tools exposed by a standalone MCP server (`triage-tools`): `email.apply_label`, `email.draft_reply`, `trello.create_card`, `triage.escalate`, `triage.log_decision`.

MCP is an open protocol (JSON-RPC over stdio/HTTP), so the server is model-agnostic — any MCP-capable client can drive it. More importantly, the server is where **trust-tier enforcement** lives:

| Tier | Sender | Permitted tools |
|---|---|---|
| 0 | Unknown sender | classify + label only |
| 1 | Known external domain | + create Trello card |
| 2 | Internal / allowlisted | + draft reply (never send) |
| — | Any tier | **send requires human approval, no exceptions** |

Every tool call carries the message ID; middleware looks up the sender's tier (derived from verified domain and SPF/DKIM headers — never the display name) and refuses out-of-policy calls. Refusals are logged and surfaced on the dashboard: "agent attempted X, blocked" is an observable event, not a silent failure. The security boundary is code in this server, not wording in a prompt.

Each call is audit-logged with arguments, result, trust tier, and token cost — one choke point for the entire action surface.

### Stage 5 — Human approval

Drafts land in an approval queue in Supabase. A human reviews each draft on the dashboard and approves, edits, or rejects. Only an approved draft is sent, and sending is performed by the queue worker — the agent has no send capability at any trust tier.

### Stage 6 — Observe

The dashboard (Next.js) shows:

- the approval queue
- per-message and per-stage token costs (real unit economics: cents per classification, per draft)
- audit log including blocked tool calls
- eval score trends over time

## 4. Threat model

Full table with mitigations and test mappings lives in [`threat-model.md`](threat-model.md). Summary of what we defend against and where the defence lives:

| Threat | Defence | Layer |
|---|---|---|
| Prompt injection in email body | Quarantine + extraction-only first pass | Stage 2 |
| Tool escalation by a compromised agent | Trust-tier middleware refuses the call | Stage 4 (code, not prompt) |
| Data exfiltration via drafts | Draft scope limited to the source thread | Stage 4 + evals |
| Sender spoofing for trust elevation | Tier from verified domain + SPF/DKIM | Stage 4 |
| Runaway cost (loops, giant threads) | Per-message token budget, hard cap, alert | Stage 3 |

Every row maps to a test: injection fixtures must score 100% (binary: classified suspicious AND zero out-of-policy calls), tier enforcement has unit tests, cost caps have a chaos fixture.

## 5. Evaluation

Three suites, run from labeled fixtures in `evals/fixtures/`:

1. **Classification accuracy** — ~60 labeled training-org emails across all categories. Precision/recall per category; CI gate at a threshold (majority vote over 3 runs to absorb model nondeterminism).
2. **Injection resistance** — ~15 attack emails (instruction override, hidden text, encoded payloads, fake system messages in quoted threads, tool-name spoofing). Pass bar is 100%, gated in CI.
3. **Draft quality** — LLM-as-judge with a rubric (addresses the question, invents no facts, no data beyond thread scope). Judged by a *different vendor's* model (Gemini) than the one drafting, to avoid self-preference bias. Tracked as a trend, not a CI gate — judge scores are too noisy to gate on; only deterministic checks gate.

Eval results are stored in Supabase and charted on the dashboard.

## 6. Cost governance

- Per-stage token logging (classification vs drafting vs evals) into a `costs` table
- Small-model-first routing; the expensive model runs only when a draft is permitted
- Development loop runs on free-tier Gemini; the production path runs Claude — one config switch
- CI runs a 10-fixture smoke subset; the full eval suite is on-demand
- Hard per-message token cap kills runaway runs and raises an alert

## 7. Repository layout

```
triage-agent/
├── docs/
│   ├── architecture.md        # this document
│   ├── threat-model.md        # threats → mitigations → tests
│   └── what-broke.md          # running log of failures and fixes
├── packages/
│   ├── core/                  # shared types, MailProvider + LLMProvider interfaces, trust tiers
│   ├── ingestor/              # cron worker, incremental sync, idempotent writes
│   ├── agent/                 # Agent SDK loop, model routing, quarantine wrapper
│   ├── mcp-server/            # triage-tools: tool defs, trust middleware, audit logging
│   └── dashboard/             # Next.js: approvals, costs, audit log, eval trends
├── evals/
│   ├── fixtures/              # labeled emails, including attack fixtures
│   └── run.ts
├── supabase/migrations/
└── .github/workflows/         # lint, unit tests, eval smoke subset
```

TypeScript monorepo throughout. Deployment target: worker on a scheduled runner (GitHub Actions cron to start, Fly.io as the production-shaped option), dashboard on Vercel, database on Supabase.

## 8. Build order

Each phase ends with a working system:

| Phase | Deliverable |
|---|---|
| 1 | Core types, `FixtureProvider`, ingestor → Supabase. *System ingests and stores.* |
| 2 | MCP server with trust middleware, audit log, unit tests. *Tools governed before any LLM exists.* |
| 3 | Agent loop, quarantine, classification, injection eval suite. *Pipeline classifies; evals run.* |
| 4 | Drafting, approval queue, minimal dashboard. *Full loop demo-able end to end.* |
| 5 | Live `GmailProvider`, deployment, cost dashboard. *Runs against a real inbox.* |
| 6 (roadmap) | `GraphProvider`, LLM-judge suite, webhook/push ingestion, HTTP transport for the MCP server |

The ordering is deliberate: the permission guard exists and is tested *before* the first model call is wired in — security is a foundation here, not a retrofit.

## 9. Decisions and trade-offs

| Decision | Choice | Why |
|---|---|---|
| Poll vs push ingestion | Poll with incremental sync | Gmail push needs Pub/Sub infrastructure; at this volume polling is well under quota and simpler to operate. Push is a documented upgrade path. |
| Own MCP server vs third-party tool servers | Own | Trust checks and audit logging must sit in the tool path; off-the-shelf servers don't provide that choke point. |
| Where permissions live | MCP server middleware | Prompt-level rules fail exactly when you need them (under injection). Code-level refusal does not. |
| Queue/state infra | Supabase for everything | One store for state, queue, audit, costs, evals. No Redis, no queue service, nothing extra to operate. |
| Model strategy | Small-first, two vendors behind one interface | Cost control, and model/vendor swaps become config changes rather than rewrites. |
| Agent never sends | Human approval always | The failure mode of a wrong send is unrecoverable; the cost of approval is a click. |
