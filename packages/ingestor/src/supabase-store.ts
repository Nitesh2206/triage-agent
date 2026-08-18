import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MessageStore, TriageMessage, UpsertResult } from '@triage/core';

/**
 * Idempotency lives in the DB: unique constraint on (provider, provider_message_id).
 * A duplicate insert violates the constraint (code 23505) and is treated as a no-op —
 * the constraint cannot race, application-level check-then-insert can.
 */
export class SupabaseStore implements MessageStore {
  /** Client injectable so error mapping is unit-testable without a live database. */
  constructor(private readonly client: SupabaseClient) {}

  static fromCredentials(url: string, serviceKey: string): SupabaseStore {
    return new SupabaseStore(createClient(url, serviceKey));
  }

  async upsertMessage(message: TriageMessage): Promise<UpsertResult> {
    const { error } = await this.client.from('messages').insert({
      provider: message.provider,
      provider_message_id: message.providerMessageId,
      provider_thread_id: message.providerThreadId ?? null,
      from_address: message.from.address,
      from_display_name: message.from.displayName ?? null,
      to_addresses: message.to.map((t) => t.address),
      cc_addresses: (message.cc ?? []).map((c) => c.address),
      in_reply_to: message.inReplyTo ?? null,
      header_references: message.headerReferences ?? [],
      subject: message.subject,
      received_at: message.receivedAt,
      body: message.body,
      auth_results: message.authResults ?? null,
    });
    if (error) {
      if (error.code === '23505') return { inserted: false };
      throw new Error(`supabase insert failed: ${error.message}`);
    }
    return { inserted: true };
  }

  async count(): Promise<number> {
    const { count, error } = await this.client
      .from('messages')
      .select('*', { count: 'exact', head: true });
    if (error) throw new Error(`supabase count failed: ${error.message}`);
    return count ?? 0;
  }
}
