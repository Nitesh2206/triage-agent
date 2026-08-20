import { describe, expect, it } from 'vitest';
import {
  checkOperator,
  type AuthUserClient,
  type OperatorLookupClient,
} from '../src/lib/operator-check';

function authWith(email?: string): AuthUserClient {
  return { auth: { getUser: async () => ({ data: { user: email ? { email } : null } }) } };
}

function lookup(result: {
  data: unknown;
  error: { message: string } | null;
}): OperatorLookupClient {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }),
  };
}

describe('checkOperator (fail closed)', () => {
  it('throws with no session', async () => {
    await expect(
      checkOperator(authWith(undefined), lookup({ data: null, error: null })),
    ).rejects.toThrow('not signed in');
  });

  it('throws when the allowlist lookup errors', async () => {
    await expect(
      checkOperator(
        authWith('op@example.com'),
        lookup({ data: null, error: { message: 'db down' } }),
      ),
    ).rejects.toThrow('operator check failed: db down');
  });

  it('throws for a signed-in non-operator', async () => {
    await expect(
      checkOperator(authWith('stranger@example.com'), lookup({ data: null, error: null })),
    ).rejects.toThrow('not an operator: stranger@example.com');
  });

  it('returns the email for a listed operator', async () => {
    await expect(
      checkOperator(
        authWith('op@example.com'),
        lookup({ data: { email: 'op@example.com' }, error: null }),
      ),
    ).resolves.toBe('op@example.com');
  });
});
