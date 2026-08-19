import 'server-only';
import { createStores, type Stores } from '@triage/store';

let cached: Stores | null = null;

/**
 * Supabase-backed stores from env. Service role key — server components and
 * server actions only; 'server-only' makes a client-bundle import a build error.
 */
export function stores(): Stores {
  if (cached) return cached;
  const s = createStores();
  if (s.backend !== 'supabase') {
    throw new Error(
      'Dashboard needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (root .env) — the in-memory fallback cannot outlive a request.',
    );
  }
  cached = s;
  return cached;
}
