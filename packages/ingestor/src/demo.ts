import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { FixtureProvider } from './fixture-provider.js';
import { MemoryStore } from './memory-store.js';
import { SupabaseStore } from './supabase-store.js';
import { ingest } from './ingest.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');
const provider = new FixtureProvider(fixtureDir);

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const store =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? new SupabaseStore(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : new MemoryStore();
console.log(`store: ${store.constructor.name}`);

const first = await ingest(provider, store);
console.log('run 1:', first);
const second = await ingest(provider, store);
console.log('run 2 (idempotency check):', second);

if (second.inserted !== 0) {
  console.error('FAIL: second run inserted rows — idempotency broken');
  process.exit(1);
}
console.log(`OK: ${await store.count()} messages stored, rerun inserted nothing`);
