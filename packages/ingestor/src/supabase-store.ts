import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MessageStore, TriageMessage, UpsertResult } from '@triage/core';

/**
 * Idempotency lives in the DB: unique constraint on (provider, provider_message_id).
 * A duplicate insert violates the constraint (code 23505) and is treated as a no-op —
 * the constraint cannot race, application-level check-then-insert can.
 */
export class SupabaseStore implements MessageStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey);
  }

  async upsertMessage(message: TriageMessage): Promise<UpsertResult> {
    const { error } = await this.client.from('messages').insert({
      provider: message.provider,
      provider_message_id: message.providerMessageId,
      from_address: message.from.address,
      from_display_name: message.from.displayName ?? null,
      to_addresses: message.to.map((t) => t.address),
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
