import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditLog } from '@triage/core';

export interface PurgeReport {
  messagesDeleted: number;
  auditDeleted: number;
  costsDeleted: number;
}

/**
 * Retention purge (threat model: runs before any real mailbox data ages out).
 * All deletion logic lives in the purge_expired() SQL function — atomic,
 * service-role-only RPC; this wrapper only picks the window and audits the
 * result. Memory stores are per-run ephemeral, so no memory parity is needed.
 */
export async function runRetention(
  client: SupabaseClient,
  audit: AuditLog,
  retentionMonths = Number(process.env.TRIAGE_RETENTION_MONTHS ?? 12),
): Promise<PurgeReport> {
  if (!Number.isFinite(retentionMonths) || retentionMonths <= 0) {
    throw new Error(`invalid TRIAGE_RETENTION_MONTHS: ${retentionMonths}`);
  }
  const { data, error } = await client.rpc('purge_expired', {
    retention: `${retentionMonths} months`,
  });
  if (error) throw new Error(`retention purge failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const report: PurgeReport = {
    messagesDeleted: Number(row?.messages_deleted ?? 0),
    auditDeleted: Number(row?.audit_deleted ?? 0),
    costsDeleted: Number(row?.costs_deleted ?? 0),
  };
  // Counts only — the purged content is gone by design and never echoed here.
  await audit.record({
    actor: 'system',
    action: 'retention_purge',
    phase: 'outcome',
    allowed: true,
    outcome: 'ok',
    detail: { retentionMonths, ...report },
  });
  return report;
}
