/**
 * Pure operator gate (no Next.js imports — unit-testable): a verified session
 * AND a row in the operators allowlist. Any failure — no session, lookup
 * error, not listed — throws. Returns the operator's email.
 */
export interface AuthUserClient {
  auth: { getUser(): Promise<{ data: { user: { email?: string } | null } }> };
}
export interface OperatorLookupClient {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        value: string,
      ): {
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export async function checkOperator(
  auth: AuthUserClient,
  service: OperatorLookupClient,
): Promise<string> {
  // getUser() verifies the JWT against Supabase — never trust getSession() here.
  const {
    data: { user },
  } = await auth.auth.getUser();
  const email = user?.email;
  if (!email) throw new Error('not signed in');
  const { data, error } = await service
    .from('operators')
    .select('email')
    .eq('email', email)
    .maybeSingle();
  if (error) throw new Error(`operator check failed: ${error.message}`);
  if (!data) throw new Error(`not an operator: ${email}`);
  return email;
}
