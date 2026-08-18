import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuditEntry, AuditLog, DraftStore, TriageMessage, TrustTier } from '@triage/core';
import { TOOL_MIN_TIER, type ToolName } from '@triage/core';
import { MemoryAuditLog, MemoryDraftStore, MemoryStore } from '@triage/store';
import { createServer, trustConfig } from '../src/index.js';

function makeMessage(id: string, from: string, aligned?: string): TriageMessage {
  return {
    provider: 'fixture',
    providerMessageId: id,
    from: { address: from },
    to: [],
    subject: 'subject',
    receivedAt: '2026-08-01T00:00:00Z',
    body: 'SECRET-BODY-CONTENT',
    authenticity: aligned ? { dmarc: 'pass', alignedDomain: aligned } : undefined,
  };
}

const tierMessages: Record<TrustTier, TriageMessage> = {
  0: makeMessage('m0', 'someone@gmail.com', 'gmail.com'),
  1: makeMessage('m1', 'accounts@safetygearco.com.au', 'safetygearco.com.au'),
  2: makeMessage('m2', 'peter@brightpath.edu.au', 'brightpath.edu.au'),
};

const argsFor: Record<ToolName, Record<string, unknown>> = {
  email_apply_label: { label: 'enrolment' },
  email_draft_reply: { body: 'SECRET-DRAFT-TEXT' },
  trello_create_card: { title: 'follow up' },
  triage_escalate: { reason: 'needs human' },
  triage_log_decision: { decision: 'spam' },
};

async function setup(overrides?: { audit?: AuditLog; drafts?: DraftStore }) {
  const messages = new MemoryStore();
  for (const m of Object.values(tierMessages)) await messages.upsertMessage(m);
  const audit = overrides?.audit ?? new MemoryAuditLog();
  const drafts = overrides?.drafts ?? new MemoryDraftStore();
  const server = createServer({ messages, audit, drafts, trust: trustConfig });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, audit, drafts };
}

function payload(result: { content?: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}

describe('tier x tool policy matrix', () => {
  for (const tier of [0, 1, 2] as TrustTier[]) {
    for (const tool of Object.keys(TOOL_MIN_TIER) as ToolName[]) {
      const shouldAllow = tier >= TOOL_MIN_TIER[tool];
      it(`tier ${tier} → ${tool}: ${shouldAllow ? 'allowed' : 'POLICY_DENIED'}`, async () => {
        const { client, audit } = await setup();
        const message = tierMessages[tier];
        const result = await client.callTool({
          name: tool,
          arguments: {
            provider: message.provider,
            providerMessageId: message.providerMessageId,
            ...argsFor[tool],
          },
        });
        expect(result.isError === true).toBe(!shouldAllow);
        if (!shouldAllow) expect(payload(result).code).toBe('POLICY_DENIED');

        const entries = await audit.list();
        const auth = entries.find((e: AuditEntry) => e.phase === 'authorization');
        expect(auth).toBeDefined();
        expect(auth!.allowed).toBe(shouldAllow);
        expect(auth!.trustTier).toBe(tier);
        if (!shouldAllow) expect(auth!.outcome).toBe('refused');
      });
    }
  }
});

describe('guard invariants', () => {
  it('denied handler never executes: tier-0 draft_reply stages no draft', async () => {
    const { client, drafts } = await setup();
    await client.callTool({
      name: 'email_draft_reply',
      arguments: { provider: 'fixture', providerMessageId: 'm0', body: 'x' },
    });
    expect(await drafts.count()).toBe(0);
  });

  it('audit persistence failure blocks execution (fail closed)', async () => {
    const failingAudit: AuditLog = {
      record: async () => {
        throw new Error('audit db down');
      },
      list: async () => [],
    };
    const { client, drafts } = await setup({ audit: failingAudit });
    const result = await client.callTool({
      name: 'email_draft_reply',
      arguments: { provider: 'fixture', providerMessageId: 'm2', body: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('AUDIT_UNAVAILABLE');
    expect(await drafts.count()).toBe(0);
  });

  it('unknown message → UNKNOWN_MESSAGE result + attempt audit row', async () => {
    const { client, audit } = await setup();
    const result = await client.callTool({
      name: 'email_apply_label',
      arguments: { provider: 'fixture', providerMessageId: 'nope', label: 'spam' },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('UNKNOWN_MESSAGE');
    const entries = await audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.phase).toBe('attempt');
    expect(entries[0]!.allowed).toBe(false);
  });

  it('handler failure is audited as outcome error', async () => {
    const throwingDrafts: DraftStore = {
      createDraft: async () => {
        throw new Error('draft table on fire');
      },
      count: async () => 0,
    };
    const { client, audit } = await setup({ drafts: throwingDrafts });
    const result = await client.callTool({
      name: 'email_draft_reply',
      arguments: { provider: 'fixture', providerMessageId: 'm2', body: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('TOOL_FAILED');
    const outcome = (await audit.list()).find((e: AuditEntry) => e.phase === 'outcome');
    expect(outcome!.outcome).toBe('error');
  });

  it('audit rows never contain draft text or message bodies', async () => {
    const { client, audit } = await setup();
    await client.callTool({
      name: 'email_draft_reply',
      arguments: { provider: 'fixture', providerMessageId: 'm2', body: 'SECRET-DRAFT-TEXT' },
    });
    const dump = JSON.stringify(await audit.list());
    expect(dump).not.toContain('SECRET-DRAFT-TEXT');
    expect(dump).not.toContain('SECRET-BODY-CONTENT');
  });
});
