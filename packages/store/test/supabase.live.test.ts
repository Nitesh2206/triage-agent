import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { TriageMessage } from '@triage/core';
import { SupabaseAuditLog, SupabaseStore } from '../src/supabase.js';

/**
 * Live integration test against the DEDICATED TEST Supabase project (never
 * prod). Skips silently without credentials — the CI live-store job fails
 * loudly instead if the secret is missing, mirroring the eval jobs.
 */
const url = process.env.TEST_SUPABASE_URL;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;

// Run-unique prefix: parallel CI runs cannot collide; afterAll deletes by prefix.
const runId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function message(id: string, receivedAt: string): TriageMessage {
  return {
    provider: 'livetest',
    providerMessageId: `${runId}-${id}`,
    from: { address: 'student@example.com' },
    to: [{ address: 'ops@example.com' }],
    subject: 'live store test',
    receivedAt,
    body: 'integration test row',
  };
}

describe.skipIf(!url || !serviceKey)('SupabaseStore (live)', () => {
  // The describe body executes at collection even when skipped — only build
  // real clients when credentials exist.
  const client = url && serviceKey ? createClient(url, serviceKey) : (null as never);
  const store = new SupabaseStore(client);

  afterAll(async () => {
    await client.from('messages').delete().like('provider_message_id', `${runId}-%`);
  });

  it('inserts, dedupes, counts, and propagates errors', async () => {
    const now = new Date().toISOString();
    expect(await store.upsertMessage(message('m1', now))).toEqual({ inserted: true });
    expect(await store.upsertMessage(message('m1', now))).toEqual({ inserted: false });
    expect(await store.count()).toBeGreaterThanOrEqual(1);

    // NOT NULL violation must surface as a thrown error, not a silent no-op.
    const bad = { ...message('m2', now), subject: null } as unknown as TriageMessage;
    await expect(store.upsertMessage(bad)).rejects.toThrow(/insert failed/);
  });

  it('purge_expired removes old rows and their audit trail, keeps recent ones', async () => {
    const audit = new SupabaseAuditLog(client);
    const old = new Date(Date.now() - 400 * 24 * 3600_000).toISOString();
    const fresh = new Date().toISOString();
    await store.upsertMessage(message('old', old));
    await store.upsertMessage(message('fresh', fresh));
    await audit.record({
      actor: 'system',
      action: 'test_event',
      phase: 'outcome',
      allowed: true,
      provider: 'livetest',
      providerMessageId: `${runId}-old`,
    });
    // Age the audit row so the row-age guard (`at < cutoff`) also passes.
    await client
      .from('audit_log')
      .update({ at: old })
      .eq('detail->>providerMessageId', `${runId}-old`);

    const { data, error } = await client.rpc('purge_expired', { retention: '12 months' });
    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(Number(row.messages_deleted)).toBeGreaterThanOrEqual(1);

    expect(await store.getMessage('livetest', `${runId}-old`)).toBeNull();
    expect(await store.getMessage('livetest', `${runId}-fresh`)).not.toBeNull();
    const { count } = await client
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('detail->>providerMessageId', `${runId}-old`);
    expect(count).toBe(0);
  });

  it('untriaged marker round-trip', async () => {
    const now = new Date().toISOString();
    await store.upsertMessage(message('triage-me', now));
    const before = await store.listUntriaged('livetest', 1000);
    expect(before.some((m) => m.providerMessageId === `${runId}-triage-me`)).toBe(true);
    await store.markTriaged('livetest', `${runId}-triage-me`);
    const after = await store.listUntriaged('livetest', 1000);
    expect(after.some((m) => m.providerMessageId === `${runId}-triage-me`)).toBe(false);
  });
});

describe.skipIf(!url || !anonKey)('RLS (live)', () => {
  it('anon key reads nothing from any table', async () => {
    const anon = createClient(url ?? '', anonKey ?? '');
    for (const table of ['messages', 'drafts', 'approvals', 'audit_log', 'costs', 'operators']) {
      const { data, error } = await anon.from(table).select('*').limit(1);
      // RLS: either an empty result or a permission error — never a row.
      if (!error) expect(data).toEqual([]);
    }
  });
});
