import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { MemoryStore } from '@triage/store';
import { FixtureProvider } from '../src/fixture-provider.js';
import { ingest } from '../src/ingest.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');

describe('FixtureProvider', () => {
  it('full sync returns all fixtures ordered by epoch', async () => {
    const { messages, nextCursor } = await new FixtureProvider(fixtureDir).sync();
    expect(messages.length).toBeGreaterThanOrEqual(10);
    const epochs = messages.map((m) => Date.parse(m.receivedAt));
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b));
    expect(nextCursor).toBe(messages[messages.length - 1]!.receivedAt);
  });

  it('sync from cursor returns only newer messages', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const { messages: all } = await provider.sync();
    const { messages: later } = await provider.sync(all[0]!.receivedAt);
    expect(later.length).toBe(all.length - 1);
  });

  it('sync from final cursor returns nothing and keeps the cursor', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const { nextCursor } = await provider.sync();
    const drained = await provider.sync(nextCursor!);
    expect(drained.messages).toEqual([]);
    expect(drained.nextCursor).toBe(nextCursor);
  });

  it('compares timestamps by epoch, not lexicographically', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const { messages: all } = await provider.sync();
    // Same instant as the first message, expressed in a +10:00 offset. Lexicographic
    // comparison against Z-suffixed strings would misorder it; epoch comparison must not.
    const offsetCursor = new Date(Date.parse(all[0]!.receivedAt)).toISOString();
    const viaOffset = await provider.sync(
      offsetCursor.replace('Z', '+00:00'),
    );
    expect(viaOffset.messages.length).toBe(all.length - 1);
  });

  it('strips eval ground-truth from pipeline messages', async () => {
    const { messages } = await new FixtureProvider(fixtureDir).sync();
    for (const m of messages) expect(m).not.toHaveProperty('expected');
  });
});

describe('ingest', () => {
  it('is idempotent: replay inserts nothing', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const store = new MemoryStore();

    const first = await ingest(provider, store);
    expect(first.inserted).toBe(first.fetched);
    expect(first.skipped).toBe(0);

    const replay = await ingest(provider, store);
    expect(replay.inserted).toBe(0);
    expect(replay.skipped).toBe(replay.fetched);
    expect(await store.count()).toBe(first.fetched);
  });

  it('advances the cursor: second run from nextCursor fetches nothing', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const store = new MemoryStore();

    const first = await ingest(provider, store);
    expect(first.nextCursor).not.toBeNull();

    const second = await ingest(provider, store, first.nextCursor!);
    expect(second.fetched).toBe(0);
    expect(second.nextCursor).toBe(first.nextCursor);
  });
});
