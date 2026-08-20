import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClassificationVerdict, LLMProvider, TriageMessage } from '@triage/core';
import { MemoryAuditLog, MemoryCostLog, MemoryDraftStore, MemoryStore } from '@triage/store';
import { createServer } from '@triage/mcp-server';
import { DEFAULT_BUDGET, triageMessage, type TriageDeps } from '../src/triage.js';

const trust = { internalDomains: ['brightpath.edu.au'], knownDomains: ['supplier.com.au'] };

const message: TriageMessage = {
  provider: 'fixture',
  providerMessageId: 'fx-t1',
  from: { address: 'someone@example.com' },
  to: [{ address: 'admin@brightpath.edu.au' }],
  subject: 'Question',
  receivedAt: '2026-08-19T00:00:00Z',
  body: 'A question about a course.',
  authenticity: { dmarc: 'pass', alignedDomain: 'example.com' },
};

/** Tier-2 sender: internal domain with aligned DMARC pass. */
const internalMessage: TriageMessage = {
  provider: 'fixture',
  providerMessageId: 'fx-t2',
  from: { address: 'megan@brightpath.edu.au' },
  to: [{ address: 'admin@brightpath.edu.au' }],
  subject: 'Intake dates',
  receivedAt: '2026-08-19T00:00:00Z',
  body: 'Student asks about October intake.',
  authenticity: { dmarc: 'pass', alignedDomain: 'brightpath.edu.au' },
};

const noFlags = {
  instructionOverride: false,
  exfiltrationAttempt: false,
  impersonation: false,
  hiddenOrEncodedContent: false,
};

function llmReturning(verdict: ClassificationVerdict, tokens = { in: 500, out: 50 }): LLMProvider {
  return {
    name: 'mock',
    classify: vi.fn(async () => ({
      verdict,
      usage: { model: 'mock', inputTokens: tokens.in, outputTokens: tokens.out, usd: 0.001 },
    })),
    draftReply: vi.fn(async () => ({
      body: 'Hi, thanks for your enquiry.',
      usage: { model: 'mock-draft', inputTokens: 600, outputTokens: 120, usd: 0.002 },
    })),
  };
}

describe('triageMessage', () => {
  let audit: MemoryAuditLog;
  let costs: MemoryCostLog;
  let drafts: MemoryDraftStore;
  let client: Client;

  beforeEach(async () => {
    const messages = new MemoryStore();
    await messages.upsertMessage(message);
    await messages.upsertMessage(internalMessage);
    audit = new MemoryAuditLog();
    costs = new MemoryCostLog();
    drafts = new MemoryDraftStore();
    const server = createServer({ messages, audit, drafts, trust });
    client = new Client({ name: 'test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  function deps(llm: LLMProvider, budget = DEFAULT_BUDGET): TriageDeps {
    return { llm, mcp: client, costs, audit, budget, trust };
  }

  it('benign verdict: exactly log_decision + apply_label, no escalate, no drafts', async () => {
    const verdict = {
      category: 'enrolment_query',
      urgency: 'normal',
      suspicion: noFlags,
      rationale: 'q',
    } as const;
    const result = await triageMessage(deps(llmReturning(verdict)), message);
    expect(result.verdict?.category).toBe('enrolment_query');
    expect(result.aborted).toBeUndefined();
    const actions = (await audit.list()).map((e) => e.action);
    expect(actions.filter((a) => a === 'triage_log_decision')).toHaveLength(2); // auth + outcome
    expect(actions.filter((a) => a === 'email_apply_label')).toHaveLength(2);
    expect(actions).not.toContain('triage_escalate');
    expect(await drafts.count()).toBe(0);
  });

  it('suspicion flag overrides category and escalates first', async () => {
    const verdict = {
      category: 'other',
      urgency: 'normal',
      suspicion: { ...noFlags, instructionOverride: true },
      rationale: 'odd',
    } as const;
    const result = await triageMessage(deps(llmReturning(verdict)), message);
    expect(result.verdict?.category).toBe('suspicious');
    const actions = (await audit.list()).map((e) => e.action);
    expect(actions).toContain('triage_escalate');
    expect(actions.indexOf('triage_escalate')).toBeLessThan(actions.indexOf('triage_log_decision'));
  });

  it('provider throw: CLASSIFY_FAILED, escalated, no decision logged', async () => {
    const llm: LLMProvider = {
      name: 'mock',
      classify: async () => {
        throw new Error('api down');
      },
    };
    const result = await triageMessage(deps(llm), message);
    expect(result.aborted).toBe('CLASSIFY_FAILED');
    const actions = (await audit.list()).map((e) => e.action);
    expect(actions).toContain('triage_escalate');
    expect(actions).not.toContain('triage_log_decision');
  });

  it('oversized input: provider never called, breach audited, escalated, zero spend', async () => {
    const big = { ...message, body: 'x'.repeat(100_000) };
    const store = new MemoryStore();
    await store.upsertMessage(big);
    const llm = llmReturning({
      category: 'other',
      urgency: 'low',
      suspicion: noFlags,
      rationale: '',
    });
    const result = await triageMessage(deps(llm), big);
    expect(result.aborted).toBe('INPUT_TOO_LARGE');
    expect(llm.classify).not.toHaveBeenCalled();
    expect(await costs.list()).toHaveLength(0);
    const breach = (await audit.list()).find((e) => e.action === 'token_budget_breach');
    expect(breach?.actor).toBe('system');
  });

  it('actual usage over maxTotalTokens: cost recorded, breach alert, verdict still acted on', async () => {
    const verdict = {
      category: 'invoice',
      urgency: 'normal',
      suspicion: noFlags,
      rationale: 'inv',
    } as const;
    const llm = llmReturning(verdict, { in: 13_000, out: 500 });
    const result = await triageMessage(deps(llm), message);
    expect(result.verdict?.category).toBe('invoice');
    expect(await costs.list()).toHaveLength(1);
    const breach = (await audit.list()).find((e) => e.action === 'token_budget_breach');
    expect(breach?.detail?.kind).toBe('actual_over_total');
    expect((await audit.list()).map((e) => e.action)).toContain('email_apply_label');
  });

  it('tool isError surfaces in actionErrors and later calls still run', async () => {
    const unknown = { ...message, providerMessageId: 'fx-missing' };
    const verdict = {
      category: 'other',
      urgency: 'low',
      suspicion: noFlags,
      rationale: 'x',
    } as const;
    const result = await triageMessage(deps(llmReturning(verdict)), unknown);
    // Message not in store: guard refuses every call with UNKNOWN_MESSAGE.
    expect(result.actionErrors).toHaveLength(2);
    expect(result.actionErrors?.every((e) => e.code === 'UNKNOWN_MESSAGE')).toBe(true);
  });

  it('transport throw is captured, later actions still run', async () => {
    let first = true;
    const flaky = {
      callTool: async (p: { name: string; arguments: Record<string, unknown> }) => {
        if (first) {
          first = false;
          throw new Error('socket closed');
        }
        return client.callTool(p);
      },
    };
    const verdict = {
      category: 'other',
      urgency: 'normal',
      suspicion: { ...noFlags, impersonation: true },
      rationale: 'x',
    } as const;
    const result = await triageMessage(
      { llm: llmReturning(verdict), mcp: flaky, costs, audit, budget: DEFAULT_BUDGET, trust },
      message,
    );
    // First call (escalate) died on transport; log_decision and apply_label still ran.
    expect(result.actionErrors).toEqual([{ tool: 'triage_escalate', code: 'TRANSPORT_ERROR' }]);
    const actions = (await audit.list()).map((e) => e.action);
    expect(actions).toContain('triage_log_decision');
    expect(actions).toContain('email_apply_label');
  });

  it('escalation audit row carries suspicion flag names', async () => {
    const verdict = {
      category: 'other',
      urgency: 'normal',
      suspicion: { ...noFlags, exfiltrationAttempt: true },
      rationale: 'x',
    } as const;
    await triageMessage(deps(llmReturning(verdict)), message);
    const row = (await audit.list()).find(
      (e) => e.action === 'triage_escalate' && e.phase === 'authorization',
    );
    expect(row?.detail?.flags).toEqual(['exfiltrationAttempt']);
  });

  it('tier-2 draftable: draft staged via MCP, draft cost row recorded', async () => {
    const verdict = {
      category: 'enrolment_query',
      urgency: 'normal',
      suspicion: noFlags,
      rationale: 'q',
    } as const;
    const llm = llmReturning(verdict);
    const result = await triageMessage(deps(llm), internalMessage);
    expect(result.drafted).toBe(true);
    expect(llm.draftReply).toHaveBeenCalledOnce();
    expect(await drafts.count()).toBe(1);
    const stages = (await costs.list()).map((c) => c.stage);
    expect(stages).toEqual(['classify', 'draft']);
    const actions = (await audit.list()).map((e) => e.action);
    expect(actions.filter((a) => a === 'email_draft_reply')).toHaveLength(2); // auth + outcome
  });

  it('tier-0 sender: draftReply never called even for a draftable category', async () => {
    const verdict = {
      category: 'enrolment_query',
      urgency: 'normal',
      suspicion: noFlags,
      rationale: 'q',
    } as const;
    const llm = llmReturning(verdict);
    const result = await triageMessage(deps(llm), message); // example.com → tier 0
    expect(result.drafted).toBeUndefined();
    expect(llm.draftReply).not.toHaveBeenCalled();
    expect(await drafts.count()).toBe(0);
  });

  it('tier-2 suspicious: never drafted', async () => {
    const verdict = {
      category: 'enrolment_query',
      urgency: 'normal',
      suspicion: { ...noFlags, instructionOverride: true },
      rationale: 'x',
    } as const;
    const llm = llmReturning(verdict);
    const result = await triageMessage(deps(llm), internalMessage);
    expect(result.verdict?.category).toBe('suspicious');
    expect(result.drafted).toBeUndefined();
    expect(llm.draftReply).not.toHaveBeenCalled();
    expect(await drafts.count()).toBe(0);
  });

  it('tier-2 non-draftable category: no draft', async () => {
    const verdict = {
      category: 'complaint',
      urgency: 'high',
      suspicion: noFlags,
      rationale: 'c',
    } as const;
    const llm = llmReturning(verdict);
    await triageMessage(deps(llm), internalMessage);
    expect(llm.draftReply).not.toHaveBeenCalled();
    expect(await drafts.count()).toBe(0);
  });

  it('draftReply throw: DRAFT_FAILED surfaced, classification actions intact', async () => {
    const verdict = {
      category: 'enrolment_query',
      urgency: 'normal',
      suspicion: noFlags,
      rationale: 'q',
    } as const;
    const llm: LLMProvider = {
      ...llmReturning(verdict),
      draftReply: async () => {
        throw new Error('model down');
      },
    };
    const result = await triageMessage(deps(llm), internalMessage);
    expect(result.verdict?.category).toBe('enrolment_query');
    expect(result.drafted).toBeUndefined();
    expect(result.actionErrors).toEqual([{ tool: 'email_draft_reply', code: 'DRAFT_FAILED' }]);
    expect((await audit.list()).map((e) => e.action)).toContain('email_apply_label');
    expect(await drafts.count()).toBe(0);
  });

  it('draft skipped when cumulative budget cannot cover it', async () => {
    const verdict = {
      category: 'enrolment_query',
      urgency: 'normal',
      suspicion: noFlags,
      rationale: 'q',
    } as const;
    const llm = llmReturning(verdict, { in: 500, out: 50 });
    const tight = { ...DEFAULT_BUDGET, maxTotalTokens: 600 };
    const result = await triageMessage(deps(llm, tight), internalMessage);
    expect(result.drafted).toBeUndefined();
    expect(llm.draftReply).not.toHaveBeenCalled();
    const skip = (await audit.list()).find(
      (e) => e.action === 'token_budget_breach' && e.detail?.kind === 'draft_skipped_over_total',
    );
    expect(skip?.allowed).toBe(false);
    expect(await drafts.count()).toBe(0);
  });

  it('records a correct cost row on the happy path', async () => {
    const verdict = {
      category: 'spam',
      urgency: 'low',
      suspicion: noFlags,
      rationale: 's',
    } as const;
    await triageMessage(deps(llmReturning(verdict)), message);
    const [row] = await costs.list();
    expect(row).toMatchObject({
      provider: 'fixture',
      providerMessageId: 'fx-t1',
      stage: 'classify',
      model: 'mock',
      inputTokens: 500,
      outputTokens: 50,
    });
  });
});
