# triage-agent

An email triage agent for a training organisation's ops inbox that treats the LLM as untrusted. It reads mail, classifies it, stages reply drafts — and a human approves anything that leaves the building. Built as an exercise in production-grade agent engineering: hostile input, permissions enforced outside the model, quality gated by evals, every run priced.

## How it works

```
Gmail → ingest (cursor sync) → quarantine → classify (LLM, zero tools)
      → guarded MCP tools (label / card / draft / escalate)
      → approval queue → human on dashboard → send (worker, not agent)
```

Four principles drive the design:

1. **Email content is evidence, never instructions.** Bodies are quarantined in nonce-delimited blocks; the classification pass has zero tools, so a prompt injection has nothing to grab.
2. **Permissions live outside the model.** An MCP server resolves each sender to a trust tier (DMARC + domain alignment, fail closed) and refuses out-of-policy tool calls in code. The agent has no send capability at any tier — the approval worker is the only send path.
3. **Quality is measured, not assumed.** An eval suite gates CI: 100% of injection fixtures must be caught, benign false positives capped, zero drafts on attack fixtures.
4. **Every run has a price tag.** Per-stage token costs land in the database and on the dashboard.

Sends are idempotent best-effort: the worker authors the RFC 5322 Message-ID and persists it *before* calling Gmail, so a crash mid-send is recovered by probing for that id instead of re-sending blind. Full reasoning in [docs/architecture.md](docs/architecture.md), threats in [docs/threat-model.md](docs/threat-model.md), build history in [docs/plan.md](docs/plan.md).

## Try it (no credentials)

```sh
pnpm install
pnpm demo        # 31 labeled fixtures through the full pipeline, fake LLM
pnpm test        # unit tests
```

The demo ingests fixtures (including injection attacks), classifies with a keyword heuristic, drives the guarded MCP tools, and stages one draft for approval — all in memory.

## Packages

| Package | What |
|---|---|
| `core` | Types, trust-tier resolution, approval worker, auth-results parser |
| `ingestor` | `GmailProvider` (historyId cursor sync), `GmailSender`, retention purge |
| `mcp-server` | Guarded tools: fail-closed two-phase audit, tier policy |
| `agent` | Triage loop, quarantine, LLM providers (Claude / Gemini / fake), live runner |
| `store` | Supabase + in-memory stores (constraint-based idempotency) |
| `dashboard` | Next.js approval queue, audit log, costs (magic-link auth + operator allowlist) |
| `evals` | Fixture suites + CI gates |

## Deploy

- **Cron tick** (`.github/workflows/triage-cron.yml`): ingest → classify → send, every 15 min on GitHub Actions
- **Dashboard**: Vercel (`packages/dashboard`, see `vercel.json`)
- **State**: Supabase — migrations in `supabase/migrations/`, RLS on everything, service role server-side only

Secrets needed: Supabase URL + service key, Gmail OAuth trio (desktop client + refresh token via `pnpm --filter @triage/ingestor gmail:consent`), Gemini or Anthropic API key.
