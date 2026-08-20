/**
 * One live tick — the GitHub Actions cron entry point:
 * retention purge → cursor-aware Gmail ingest → triage untriaged → send approved.
 * Every stage composes pieces that already exist; this file only wires them.
 */
import { createClient } from '@supabase/supabase-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { processApprovals } from '@triage/core';
import { createStores } from '@triage/store';
import {
  GmailProvider,
  createSender,
  gmailClient,
  runRetention,
  syncOnce,
  type GmailApi,
} from '@triage/ingestor';
import { createServer, trustConfig } from '@triage/mcp-server';
import { createProvider } from './provider.js';
import { DEFAULT_BUDGET, triageMessage, type TriageResult } from './triage.js';

const BATCH_LIMIT = 25; // per tick; the cursor + untriaged marker carry the rest to the next tick

const stores = createStores();
if (stores.backend !== 'supabase') {
  console.error('run-live needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const { messages, audit, drafts, approvals, costs, syncState } = stores;
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// 1. Retention purge (threat model: before anything else touches the data).
const purge = await runRetention(supabase, audit);
console.log(
  `retention: ${purge.messagesDeleted} messages, ${purge.auditDeleted} audit, ${purge.costsDeleted} cost rows purged`,
);

// 2. Cursor-aware ingest.
const gmail = gmailClient() as unknown as GmailApi;
const sync = await syncOnce(new GmailProvider(gmail), messages, syncState);
if (!sync.ran) {
  console.log(`ingest skipped: ${sync.reason}`);
} else {
  console.log(
    `ingest: ${sync.report.fetched} fetched, ${sync.report.inserted} new, cursor=${sync.report.nextCursor}`,
  );
}

// 3. Triage everything not yet triaged (rerun-safe: crash resumes here next tick).
const batch = await messages.listUntriaged('gmail', BATCH_LIMIT);
const results: TriageResult[] = [];
if (batch.length > 0) {
  const server = createServer({ messages, audit, drafts, trust: trustConfig });
  const client = new Client({ name: 'triage-agent', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const mcp = {
    callTool: (p: { name: string; arguments: Record<string, unknown> }) =>
      client.callTool(p) as Promise<{ isError?: boolean; content?: unknown }>,
  };
  const deps = {
    llm: createProvider(),
    mcp,
    costs,
    audit,
    budget: DEFAULT_BUDGET,
    trust: trustConfig,
  };

  for (const message of batch) {
    const result = await triageMessage(deps, message);
    results.push(result);
    if (result.aborted === 'CLASSIFY_FAILED') {
      // Transient LLM failure: leave untriaged; the next tick retries.
      console.log(
        `${message.providerMessageId} classify failed (${result.abortReason}) — will retry next tick`,
      );
      continue;
    }
    await messages.markTriaged('gmail', message.providerMessageId);
    console.log(
      `${message.providerMessageId} ${result.verdict?.category ?? `ABORTED:${result.aborted}`}${result.drafted ? ' [drafted]' : ''}`,
    );
  }
  await client.close();
}

// 4. Send approved drafts + recover stuck sends (the only send path).
const send = await processApprovals({ approvals, drafts, messages, audit, sender: createSender() });
console.log(`send: ${send.sent.length} sent, ${send.failed.length} failed`);
for (const f of send.failed) console.log(`  ${f.draftId}: ${f.reason}`);

const actionErrors = results.filter((r) => r.actionErrors?.length);
if (actionErrors.length > 0) {
  console.error(`FAIL: ${actionErrors.length} messages with action errors`);
  process.exit(1);
}
console.log('OK');
