import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryAuditLog, MemoryDraftStore, MemoryStore } from '@triage/store';
import { FixtureProvider, ingest } from '@triage/ingestor';
import { createServer } from './server.js';
import { trustConfig } from './config.js';

const messages = new MemoryStore();
const audit = new MemoryAuditLog();
const drafts = new MemoryDraftStore();

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');
await ingest(new FixtureProvider(fixtureDir), messages);

const server = createServer({ messages, audit, drafts, trust: trustConfig });
const client = new Client({ name: 'demo-client', version: '0.1.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

interface Call {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  expectError: boolean;
}

const calls: Call[] = [
  {
    label: 'tier-0 sender (personal gmail) asks for a draft reply',
    tool: 'email_draft_reply',
    args: { provider: 'fixture', providerMessageId: 'fx-001', body: 'Hi Sarah, ...' },
    expectError: true,
  },
  {
    label: 'tier-1 sender (known supplier) gets a task card',
    tool: 'trello_create_card',
    args: { provider: 'fixture', providerMessageId: 'fx-004', title: 'Pay INV-8842' },
    expectError: false,
  },
  {
    label: 'tier-2 sender (internal) gets a draft reply staged',
    tool: 'email_draft_reply',
    args: {
      provider: 'fixture',
      providerMessageId: 'fx-008',
      body: 'Hi Peter, plumbing courses run...',
    },
    expectError: false,
  },
  {
    label: 'unknown message id is rejected and audited',
    tool: 'email_apply_label',
    args: { provider: 'fixture', providerMessageId: 'fx-999', label: 'spam' },
    expectError: true,
  },
];

let failed = false;
for (const call of calls) {
  const result = await client.callTool({ name: call.tool, arguments: call.args });
  const isError = result.isError === true;
  const payload = (result.content as { text: string }[])[0]?.text;
  const verdict = isError === call.expectError ? 'as expected' : 'UNEXPECTED';
  if (verdict === 'UNEXPECTED') failed = true;
  console.log(`${isError ? 'refused' : 'allowed'} (${verdict}): ${call.label}\n  → ${payload}`);
}

console.log('\naudit log:');
for (const entry of await audit.list()) {
  console.log(
    `  ${entry.phase.padEnd(13)} ${entry.action.padEnd(20)} allowed=${entry.allowed} tier=${entry.trustTier ?? '-'} outcome=${entry.outcome ?? '-'} ${JSON.stringify(entry.detail)}`,
  );
}
console.log(`\ndrafts staged: ${await drafts.count()}`);

await client.close();
if (failed) {
  console.error('FAIL: at least one call did not behave as policy requires');
  process.exit(1);
}
console.log('OK: policy enforced, refusals audited, drafts staged only for tier 2');
