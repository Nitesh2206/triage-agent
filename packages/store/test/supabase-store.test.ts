import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TriageMessage } from '@triage/core';
import { SupabaseApprovalStore, SupabaseCostLog, SupabaseStore } from '../src/supabase.js';

const message: TriageMessage = {
  provider: 'fixture',
  providerMessageId: 'fx-test',
  from: { address: 'a@example.com' },
  to: [{ address: 'b@example.com' }],
  subject: 'test',
  receivedAt: '2026-08-01T00:00:00Z',
  body: 'hello',
};

/** Stub only the surface SupabaseStore touches: from().insert() / from().select(). */
function stubClient(result: {
  insertError?: { code: string; message: string };
  count?: number;
  countError?: { message: string };
}): SupabaseClient {
  return {
    from: () => ({
      insert: async () => ({ error: result.insertError ?? null }),
      select: async () => ({
        count: result.count ?? null,
        error: result.countError ?? null,
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('SupabaseStore error mapping', () => {
  it('successful insert reports inserted', async () => {
    const store = new SupabaseStore(stubClient({}));
    expect(await store.upsertMessage(message)).toEqual({ inserted: true });
  });

  it('unique violation (23505) is an idempotent no-op, not an error', async () => {
    const store = new SupabaseStore(
      stubClient({ insertError: { code: '23505', message: 'duplicate key' } }),
    );
    expect(await store.upsertMessage(message)).toEqual({ inserted: false });
  });

  it('non-23505 errors propagate', async () => {
    const store = new SupabaseStore(
      stubClient({ insertError: { code: '42P01', message: 'relation "messages" does not exist' } }),
    );
    await expect(store.upsertMessage(message)).rejects.toThrow(
      /relation "messages" does not exist/,
    );
  });

  it('count returns the exact count and propagates errors', async () => {
    expect(await new SupabaseStore(stubClient({ count: 7 })).count()).toBe(7);
    await expect(
      new SupabaseStore(stubClient({ countError: { message: 'boom' } })).count(),
    ).rejects.toThrow(/boom/);
  });
});

/**
 * Stub for the conditional-update chains: update().eq().eq().select() resolves
 * to {data, error}; select() is also chainable with .order() for list paths.
 */
function updateStub(
  data: unknown[] | null,
  error: { message: string } | null = null,
): SupabaseClient {
  const result = { data, error };
  const terminal = () => Object.assign(Promise.resolve(result), { order: async () => result });
  const chain = {
    update: () => chain,
    insert: async () => ({ error }),
    eq: () => chain,
    select: terminal,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe('SupabaseApprovalStore', () => {
  it('decide succeeds when the row was pending', async () => {
    await expect(
      new SupabaseApprovalStore(updateStub([{ id: 1 }])).decide('1', {
        status: 'approved',
        decidedBy: 'ops',
      }),
    ).resolves.toBeUndefined();
  });

  it('decide throws when zero rows matched (not pending)', async () => {
    await expect(
      new SupabaseApprovalStore(updateStub([])).decide('1', {
        status: 'approved',
        decidedBy: 'ops',
      }),
    ).rejects.toThrow(/not pending/);
  });

  it('claimForSend maps matched rows to true/false', async () => {
    expect(await new SupabaseApprovalStore(updateStub([{ id: 1 }])).claimForSend('1')).toBe(true);
    expect(await new SupabaseApprovalStore(updateStub([])).claimForSend('1')).toBe(false);
  });

  it('markSent throws when the row was not in sending', async () => {
    await expect(new SupabaseApprovalStore(updateStub([])).markSent('1')).rejects.toThrow(
      /sending/,
    );
  });

  it('database errors propagate', async () => {
    await expect(
      new SupabaseApprovalStore(updateStub(null, { message: 'boom' })).claimForSend('1'),
    ).rejects.toThrow(/boom/);
  });
});

describe('SupabaseCostLog', () => {
  it('list maps snake_case rows to CostEntry', async () => {
    const row = {
      provider: 'fixture',
      provider_message_id: 'fx-1',
      stage: 'draft',
      model: 'claude-sonnet-5',
      input_tokens: 100,
      output_tokens: 20,
      usd: '0.0006',
    };
    const [entry] = await new SupabaseCostLog(updateStub([row])).list();
    expect(entry).toEqual({
      provider: 'fixture',
      providerMessageId: 'fx-1',
      stage: 'draft',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 20,
      usd: 0.0006,
    });
  });

  it('write errors propagate', async () => {
    await expect(
      new SupabaseCostLog(updateStub(null, { message: 'boom' })).record({
        provider: 'fixture',
        providerMessageId: 'fx-1',
        stage: 'classify',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        usd: 0,
      }),
    ).rejects.toThrow(/boom/);
  });
});
