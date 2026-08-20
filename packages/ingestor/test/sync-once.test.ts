import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CursorExpiredError, type MailProvider, type SyncResult } from '@triage/core';
import { MemoryStore, MemorySyncStateStore } from '@triage/store';
import { FixtureProvider } from '../src/fixture-provider.js';
import { syncOnce } from '../src/sync-once.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');

describe('syncOnce', () => {
  it('persists the cursor after the page is stored; next run fetches nothing', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const messages = new MemoryStore();
    const syncState = new MemorySyncStateStore();

    const first = await syncOnce(provider, messages, syncState);
    if (!first.ran) throw new Error('expected run');
    expect(first.report.inserted).toBe(first.report.fetched);
    expect((await syncState.get('fixture'))?.cursor).toBe(first.report.nextCursor);

    const second = await syncOnce(provider, messages, syncState);
    if (!second.ran) throw new Error('expected run');
    expect(second.report.fetched).toBe(0);
  });

  it('crash before cursor advance replays the page with zero duplicate inserts', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const messages = new MemoryStore();

    // Simulate the crash: page stored, but the cursor write never happened.
    const failingState = {
      get: async () => null,
      set: async () => {
        throw new Error('crash before cursor advance');
      },
    };
    await expect(syncOnce(provider, messages, failingState)).rejects.toThrow('crash');
    const stored = await messages.count();
    expect(stored).toBeGreaterThan(0);

    // Replay from scratch: everything upserts as a no-op.
    const syncState = new MemorySyncStateStore();
    const replay = await syncOnce(provider, messages, syncState);
    if (!replay.ran) throw new Error('expected run');
    expect(replay.report.inserted).toBe(0);
    expect(await messages.count()).toBe(stored);
  });

  it('expired cursor falls back to a full resync', async () => {
    const inner = new FixtureProvider(fixtureDir);
    const provider: MailProvider = {
      name: 'fixture',
      async sync(cursor?: string): Promise<SyncResult> {
        if (cursor === 'expired') throw new CursorExpiredError('fixture');
        return inner.sync(cursor);
      },
    };
    const messages = new MemoryStore();
    const syncState = new MemorySyncStateStore();
    await syncState.set('fixture', { cursor: 'expired', failureCount: 0, nextRetryAt: null });

    const result = await syncOnce(provider, messages, syncState);
    if (!result.ran) throw new Error('expected run');
    expect(result.report.fetched).toBeGreaterThan(0);
    expect((await syncState.get('fixture'))?.cursor).toBe(result.report.nextCursor);
  });

  it('failures back off exponentially and skip runs until nextRetryAt', async () => {
    const provider: MailProvider = {
      name: 'gmail',
      async sync(): Promise<SyncResult> {
        throw new Error('api down');
      },
    };
    const messages = new MemoryStore();
    const syncState = new MemorySyncStateStore();
    const t0 = new Date('2026-08-20T00:00:00Z');

    await expect(syncOnce(provider, messages, syncState, () => t0)).rejects.toThrow('api down');
    const after1 = await syncState.get('gmail');
    expect(after1?.failureCount).toBe(1);
    expect(after1?.nextRetryAt).toBe(new Date(t0.getTime() + 2 * 60_000).toISOString());

    // Within the backoff window: skipped without touching the provider.
    const skipped = await syncOnce(provider, messages, syncState, () => t0);
    expect(skipped.ran).toBe(false);

    // Past the window: runs (and fails) again, doubling the backoff.
    const t1 = new Date(t0.getTime() + 3 * 60_000);
    await expect(syncOnce(provider, messages, syncState, () => t1)).rejects.toThrow('api down');
    const after2 = await syncState.get('gmail');
    expect(after2?.failureCount).toBe(2);
    expect(after2?.nextRetryAt).toBe(new Date(t1.getTime() + 4 * 60_000).toISOString());
  });
});

describe('untriaged marker (rerun idempotency)', () => {
  it('replay never re-surfaces triaged messages', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const messages = new MemoryStore();
    const syncState = new MemorySyncStateStore();
    await syncOnce(provider, messages, syncState);

    const batch = await messages.listUntriaged('fixture', 1000);
    expect(batch.length).toBeGreaterThan(0);
    for (const m of batch) await messages.markTriaged('fixture', m.providerMessageId);

    // Cursor replay from scratch: page re-ingests as no-ops, nothing re-surfaces.
    await syncState.set('fixture', { cursor: null, failureCount: 0, nextRetryAt: null });
    await syncOnce(provider, messages, syncState);
    expect(await messages.listUntriaged('fixture', 1000)).toEqual([]);
  });
});
