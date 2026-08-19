import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStores } from '@triage/store';
import { FixtureProvider, ingest } from '@triage/ingestor';
import { createServer, trustConfig } from '@triage/mcp-server';
import { createProvider } from './provider.js';
import { DEFAULT_BUDGET, triageMessage, type TriageResult } from './triage.js';

const { backend, messages, audit, drafts, costs } = createStores();

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');
const report = await ingest(new FixtureProvider(fixtureDir), messages);

const server = createServer({ messages, audit, drafts, trust: trustConfig });
const client = new Client({ name: 'triage-agent', version: '0.1.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const llm = createProvider();
console.log(`provider: ${llm.name}, store: ${backend} — ${report.fetched} fixtures ingested\n`);

// Adapter: Client.callTool's full signature is wider than the loop needs.
const mcp = {
  callTool: (p: { name: string; arguments: Record<string, unknown> }) =>
    client.callTool(p) as Promise<{ isError?: boolean; content?: unknown }>,
};
const deps = { llm, mcp, costs, audit, budget: DEFAULT_BUDGET, trust: trustConfig };
const results: TriageResult[] = [];
const { messages: all } = await new FixtureProvider(fixtureDir).sync();
for (const message of all) {
  const result = await triageMessage(deps, message);
  results.push(result);
  const v = result.verdict;
  const flags = v
    ? Object.entries(v.suspicion)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .join(',') || '-'
    : '-';
  console.log(
    `${message.providerMessageId.padEnd(8)} ${(v ? v.category : `ABORTED:${result.aborted}`).padEnd(22)} ${(v?.urgency ?? '-').padEnd(7)} flags=${flags}${result.drafted ? ' [drafted]' : ''}`,
  );
}

const spend = await costs.list();
const totalUsd = spend.reduce((s, c) => s + c.usd, 0);
const totalTokens = spend.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0);
const entries = await audit.list();
const draftedCount = results.filter((r) => r.drafted).length;
console.log(`\naudit rows: ${entries.length} (refused: ${entries.filter((e) => !e.allowed).length})`);
console.log(`drafts staged this run: ${draftedCount} (total in store: ${await drafts.count()})`);
console.log(`cost: ${totalTokens} tokens, $${totalUsd.toFixed(4)} across ${spend.length} calls`);

await client.close();

const unexpected = results.filter((r) => r.aborted === 'CLASSIFY_FAILED' || r.actionErrors?.length);
if (unexpected.length > 0 || draftedCount === 0) {
  console.error(
    `FAIL: ${unexpected.length} unexpected aborts/action errors; drafted=${draftedCount} (expected >0 — tier-2 draftable fixtures exist)`,
  );
  process.exit(1);
}
console.log('OK: all messages triaged through MCP tools; drafts staged for approval');
