# What broke

Running log of failures, wrong assumptions, and fixes. Newest first.

## Phase 2 build (2026-08-18)

**Dotted tool names are invalid.** The design docs named tools `email.apply_label` etc., but MCP/LLM tool names must match `[a-zA-Z0-9_-]+` — dots are rejected by model APIs. Caught before wiring; renamed to `email_apply_label` style everywhere. Lesson: check the naming constraints of the protocol before the names appear in three documents.

**Stores were in the wrong package.** `MemoryStore`/`SupabaseStore` lived in `@triage/ingestor`; the MCP server needing them would have made the tool layer depend on the mail-ingestion package — backwards. Extracted `@triage/store` (implementations) while interfaces stayed in `@triage/core`. Cheap now; a refactor after phase 3 would have rippled through the agent package too.

## Phase 1 review findings (2026-08-18)

**RLS missing on every table — despite "security-first" being the project thesis.** The initial migration created `messages`, `audit_log`, and `costs` in Supabase's exposed `public` schema without row level security, meaning the anon API key could read student email. The build order put the *agent's* security (trust tiers, quarantine) first and quietly skipped the *database's*. Fix: RLS enabled on all tables, no policies until the dashboard needs deliberate ones; backend uses the service role. Lesson: a security-first build order has to cover every surface, not just the interesting one.

**Sync contract designed around timestamps, but Gmail syncs by opaque cursor.** `MailProvider.listNewMessages(since: ISO)` looked provider-neutral but was really fixture-shaped: Gmail's incremental sync uses an opaque `historyId` (with expiry and forced full resync), Graph uses a `deltaLink`. Caught at review before any real provider existed, so the fix was minutes instead of a refactor: `sync(cursor?) → { messages, nextCursor }` plus `CursorExpiredError`, and a `sync_state` table for durable cursors. Lesson: an abstraction is only provider-agnostic if you check it against the providers you haven't written yet.

**ISO timestamps compared lexicographically.** String comparison of ISO-8601 dates silently misorders mixed-offset timestamps (`+10:00` vs `Z`). Worked on fixtures because they were all UTC. Fix: compare `Date.parse()` epochs; regression test uses a non-Z offset.

## Phase 1 build (2026-08-18)

**First build failed: missing `@types/node`.** TypeScript couldn't resolve `node:fs/promises` etc. in a fresh monorepo — `@types/node` isn't implied by having Node installed. Added as a root dev dependency.

**Lint rejected the destructure-to-discard pattern.** `const { expected: _expected, ...message }` tripped `no-unused-vars`; needed the conventional `^_` ignore patterns configured explicitly in the flat ESLint config.
