import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TriageMessage } from '@triage/core';
import { SupabaseStore } from '../src/supabase.js';

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
    await expect(store.upsertMessage(message)).rejects.toThrow(/relation "messages" does not exist/);
  });

  it('count returns the exact count and propagates errors', async () => {
    expect(await new SupabaseStore(stubClient({ count: 7 })).count()).toBe(7);
    await expect(
      new SupabaseStore(stubClient({ countError: { message: 'boom' } })).count(),
    ).rejects.toThrow(/boom/);
  });
});
