import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { FixtureProvider } from '../src/fixture-provider.js';
import { MemoryStore } from '../src/memory-store.js';
import { ingest } from '../src/ingest.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');

describe('FixtureProvider', () => {
  it('loads all fixtures sorted by receivedAt', async () => {
    const messages = await new FixtureProvider(fixtureDir).listNewMessages();
    expect(messages.length).toBeGreaterThanOrEqual(10);
    const dates = messages.map((m) => m.receivedAt);
    expect(dates).toEqual([...dates].sort());
  });

  it('filters by since', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const all = await provider.listNewMessages();
    const later = await provider.listNewMessages(all[0]!.receivedAt);
    expect(later.length).toBe(all.length - 1);
  });

  it('strips eval ground-truth from pipeline messages', async () => {
    const messages = await new FixtureProvider(fixtureDir).listNewMessages();
    for (const m of messages) expect(m).not.toHaveProperty('expected');
  });
});

describe('ingest', () => {
  it('is idempotent: rerun inserts nothing', async () => {
    const provider = new FixtureProvider(fixtureDir);
    const store = new MemoryStore();

    const first = await ingest(provider, store);
    expect(first.inserted).toBe(first.fetched);
    expect(first.skipped).toBe(0);

    const second = await ingest(provider, store);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(second.fetched);
    expect(await store.count()).toBe(first.fetched);
  });
});
