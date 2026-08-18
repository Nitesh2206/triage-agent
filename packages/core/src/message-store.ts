import type { TriageMessage } from './types.js';

export interface UpsertResult {
  inserted: boolean; // false = already stored (idempotent no-op)
}

/**
 * Persistence abstraction. Implementations: SupabaseStore (shared/prod),
 * MemoryStore (tests and credential-free demo).
 */
export interface MessageStore {
  upsertMessage(message: TriageMessage): Promise<UpsertResult>;
  /** Lookup by the compound key — provider ids are only unique per provider. */
  getMessage(provider: string, providerMessageId: string): Promise<TriageMessage | null>;
  count(): Promise<number>;
}
