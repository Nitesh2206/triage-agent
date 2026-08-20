'use server';

import { revalidatePath } from 'next/cache';
import { processApprovals } from '@triage/core';
import { createSender, hasGmailEnv } from '@triage/ingestor';
import { requireOperator } from '../lib/auth';
import { stores } from '../lib/stores';

/**
 * Decisions require a signed-in operator (Supabase session + allowlist,
 * see lib/auth.ts) AND the server-side env kill switch. Both fail closed;
 * neither is client-influenced — request headers are spoofable.
 */
async function assertApprovalsEnabled(): Promise<string> {
  if (process.env.TRIAGE_ALLOW_APPROVALS !== '1') {
    throw new Error(
      'approval actions are disabled: set TRIAGE_ALLOW_APPROVALS=1 (server env kill switch)',
    );
  }
  return requireOperator();
}

export async function approve(formData: FormData): Promise<void> {
  const operator = await assertApprovalsEnabled();
  const draftId = String(formData.get('draftId'));
  const editedBody = formData.get('body');
  const original = formData.get('originalBody');
  if (typeof editedBody !== 'string' || editedBody.trim().length === 0) {
    throw new Error('cannot approve an empty reply body');
  }
  const { approvals, drafts, messages, audit } = stores();
  await approvals.decide(draftId, {
    status: 'approved',
    // Store an edited body only when the reviewer actually changed the text.
    editedBody: editedBody !== original ? editedBody : undefined,
    decidedBy: operator,
  });
  // Run the queue worker inline only when this process can actually send:
  // real Gmail credentials, or an explicit local-demo opt-in. Otherwise a
  // simulated send would mark the draft 'sent' while nothing left (Vercel has
  // no Gmail env by design) — the row stays 'approved' and the cron tick,
  // which does have credentials, performs the real send.
  if (hasGmailEnv() || process.env.TRIAGE_SIMULATED_SEND === '1') {
    await processApprovals({ approvals, drafts, messages, audit, sender: createSender() });
  }
  revalidatePath('/');
}

export async function reject(formData: FormData): Promise<void> {
  const operator = await assertApprovalsEnabled();
  const draftId = String(formData.get('draftId'));
  const { approvals } = stores();
  await approvals.decide(draftId, { status: 'rejected', decidedBy: operator });
  revalidatePath('/');
}
