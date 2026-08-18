import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { MemoryStore, SupabaseStore } from '@triage/store';
import { FixtureProvider } from './fixture-provider.js';
import { ingest } from './ingest.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');
const provider = new FixtureProvider(fixtureDir);

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const store =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? SupabaseStore.fromCredentials(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : new MemoryStore();
console.log(`store: ${store.constructor.name}`);

const first = await ingest(provider, store);
console.log('run 1 (full sync):', first);

const second = await ingest(provider, store, first.nextCursor ?? undefined);
console.log('run 2 (from cursor):', second);

const replay = await ingest(provider, store);
console.log('run 3 (replay without cursor — idempotency):', replay);

if (second.fetched !== 0) {
  console.error('FAIL: cursor did not advance — run 2 fetched messages');
  process.exit(1);
}
if (replay.inserted !== 0) {
  console.error('FAIL: replay inserted rows — idempotency broken');
  process.exit(1);
}
console.log(`OK: ${await store.count()} messages stored; cursor advance and replay both clean`);
