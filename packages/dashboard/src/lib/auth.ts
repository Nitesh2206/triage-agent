import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { checkOperator, type OperatorLookupClient } from './operator-check';

/** Cookie-session Supabase client (anon key) for reading the signed-in user. */
export async function authClient() {
  const cookieStore = await cookies();
  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: { name: string; value: string; options: CookieOptions }[]) => {
          try {
            for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
          } catch {
            // Server components cannot set cookies; middleware refreshes the session.
          }
        },
      },
    },
  );
}

let service: SupabaseClient | null = null;
function serviceClient(): SupabaseClient {
  service ??= createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));
  return service;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

/**
 * Fail-closed operator gate: a verified session AND a row in the operators
 * allowlist (service-role lookup — the allowlist itself is not readable by
 * the authenticated role). Logic lives in operator-check.ts (unit-tested);
 * this wires the real cookie session + service client.
 * Returns the operator's email for decidedBy attribution.
 */
export async function requireOperator(): Promise<string> {
  // Structural cast: SupabaseClient's deep generics choke tsc against the
  // minimal OperatorLookupClient shape; runtime shape matches exactly.
  return checkOperator(await authClient(), serviceClient() as unknown as OperatorLookupClient);
}
