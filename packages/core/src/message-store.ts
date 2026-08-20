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
  /**
   * Rerun idempotency: the live runner triages only untriaged rows, so a
   * cursor replay or a crash between ingest and triage never re-triages.
   */
  listUntriaged(provider: string, limit: number): Promise<TriageMessage[]>;
  markTriaged(provider: string, providerMessageId: string): Promise<void>;
}
