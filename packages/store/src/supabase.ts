import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Approval,
  ApprovalStore,
  AuditEntry,
  AuditLog,
  CostEntry,
  CostLog,
  DraftRecord,
  DraftStore,
  MessageStore,
  TriageMessage,
  UpsertResult,
} from '@triage/core';

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
      dmarc: message.authenticity?.dmarc ?? null,
      aligned_domain: message.authenticity?.alignedDomain ?? null,
      auth_results_raw: message.authResultsRaw ?? null,
    });
    if (error) {
      if (error.code === '23505') return { inserted: false };
      throw new Error(`supabase insert failed: ${error.message}`);
    }
    return { inserted: true };
  }

  async getMessage(provider: string, providerMessageId: string): Promise<TriageMessage | null> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('provider', provider)
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();
    if (error) throw new Error(`supabase select failed: ${error.message}`);
    if (!data) return null;
    return {
      provider: data.provider,
      providerMessageId: data.provider_message_id,
      providerThreadId: data.provider_thread_id ?? undefined,
      from: { address: data.from_address, displayName: data.from_display_name ?? undefined },
      to: (data.to_addresses as string[]).map((address) => ({ address })),
      cc: (data.cc_addresses as string[]).map((address) => ({ address })),
      inReplyTo: data.in_reply_to ?? undefined,
      headerReferences: data.header_references ?? [],
      subject: data.subject,
      receivedAt: data.received_at,
      body: data.body,
      authenticity: data.dmarc
        ? { dmarc: data.dmarc, alignedDomain: data.aligned_domain ?? undefined }
        : undefined,
      authResultsRaw: data.auth_results_raw ?? undefined,
    };
  }

  async count(): Promise<number> {
    const { count, error } = await this.client
      .from('messages')
      .select('*', { count: 'exact', head: true });
    if (error) throw new Error(`supabase count failed: ${error.message}`);
    return count ?? 0;
  }
}

export class SupabaseAuditLog implements AuditLog {
  constructor(private readonly client: SupabaseClient) {}

  async record(entry: AuditEntry): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      actor: entry.actor,
      action: entry.action,
      allowed: entry.allowed,
      trust_tier: entry.trustTier ?? null,
      detail: {
        phase: entry.phase,
        outcome: entry.outcome,
        provider: entry.provider,
        providerMessageId: entry.providerMessageId,
        ...entry.detail,
      },
    });
    if (error) throw new Error(`audit write failed: ${error.message}`);
  }

  async list(): Promise<AuditEntry[]> {
    const { data, error } = await this.client.from('audit_log').select('*').order('at');
    if (error) throw new Error(`audit read failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      actor: row.actor,
      action: row.action,
      allowed: row.allowed,
      trustTier: row.trust_tier ?? undefined,
      phase: row.detail?.phase,
      outcome: row.detail?.outcome,
      provider: row.detail?.provider,
      providerMessageId: row.detail?.providerMessageId,
      detail: row.detail,
    }));
  }
}

export class SupabaseDraftStore implements DraftStore {
  constructor(private readonly client: SupabaseClient) {}

  async createDraft(draft: {
    provider: string;
    providerMessageId: string;
    body: string;
  }): Promise<{ draftId: string }> {
    const { data, error } = await this.client
      .from('drafts')
      .insert({
        provider: draft.provider,
        provider_message_id: draft.providerMessageId,
        body: draft.body,
      })
      .select('id')
      .single();
    if (error) throw new Error(`draft insert failed: ${error.message}`);
    return { draftId: String(data.id) };
  }

  async getDraft(draftId: string): Promise<DraftRecord | null> {
    const { data, error } = await this.client
      .from('drafts')
      .select('*')
      .eq('id', Number(draftId))
      .maybeSingle();
    if (error) throw new Error(`draft select failed: ${error.message}`);
    return data ? mapDraft(data) : null;
  }

  async listDrafts(): Promise<DraftRecord[]> {
    const { data, error } = await this.client.from('drafts').select('*').order('id');
    if (error) throw new Error(`draft list failed: ${error.message}`);
    return (data ?? []).map(mapDraft);
  }

  async count(): Promise<number> {
    const { count, error } = await this.client
      .from('drafts')
      .select('*', { count: 'exact', head: true });
    if (error) throw new Error(`draft count failed: ${error.message}`);
    return count ?? 0;
  }
}

function mapDraft(row: {
  id: number;
  provider: string;
  provider_message_id: string;
  body: string;
  created_at: string;
}): DraftRecord {
  return {
    draftId: String(row.id),
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * State transitions are conditional updates on the current status — the WHERE
 * clause is the lock. Zero rows updated = someone else moved the row first.
 */
export class SupabaseApprovalStore implements ApprovalStore {
  constructor(private readonly client: SupabaseClient) {}

  async list(): Promise<Approval[]> {
    const { data, error } = await this.client.from('approvals').select('*').order('id');
    if (error) throw new Error(`approvals list failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      draftId: String(row.draft_id),
      status: row.status,
      editedBody: row.edited_body ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      decidedAt: row.decided_at ?? undefined,
      sentAt: row.sent_at ?? undefined,
    }));
  }

  async decide(
    draftId: string,
    decision: { status: 'approved' | 'rejected'; editedBody?: string; decidedBy: string },
  ): Promise<void> {
    const { data, error } = await this.client
      .from('approvals')
      .update({
        status: decision.status,
        edited_body: decision.editedBody ?? null,
        decided_by: decision.decidedBy,
        decided_at: new Date().toISOString(),
      })
      .eq('draft_id', Number(draftId))
      .eq('status', 'pending')
      .select('id');
    if (error) throw new Error(`approval decide failed: ${error.message}`);
    if ((data ?? []).length === 0) throw new Error(`approval ${draftId} is not pending`);
  }

  async claimForSend(draftId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('approvals')
      .update({ status: 'sending' })
      .eq('draft_id', Number(draftId))
      .eq('status', 'approved')
      .select('id');
    if (error) throw new Error(`approval claim failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async markSent(draftId: string): Promise<void> {
    const { data, error } = await this.client
      .from('approvals')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('draft_id', Number(draftId))
      .eq('status', 'sending')
      .select('id');
    if (error) throw new Error(`approval markSent failed: ${error.message}`);
    if ((data ?? []).length === 0) throw new Error(`approval ${draftId} is not in 'sending'`);
  }
}

export class SupabaseCostLog implements CostLog {
  constructor(private readonly client: SupabaseClient) {}

  async record(entry: CostEntry): Promise<void> {
    const { error } = await this.client.from('costs').insert({
      provider: entry.provider,
      provider_message_id: entry.providerMessageId,
      stage: entry.stage,
      model: entry.model,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      usd: entry.usd,
    });
    if (error) throw new Error(`cost write failed: ${error.message}`);
  }

  async list(): Promise<CostEntry[]> {
    const { data, error } = await this.client.from('costs').select('*').order('id');
    if (error) throw new Error(`cost read failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      provider: row.provider,
      providerMessageId: row.provider_message_id,
      stage: row.stage,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      usd: Number(row.usd),
    }));
  }
}
