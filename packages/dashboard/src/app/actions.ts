'use server';

import { revalidatePath } from 'next/cache';
import { processApprovals, type MailSender } from '@triage/core';
import { stores } from '../lib/stores';

/** Phase 4 sender: records the send in the audit log only. Real Gmail send is phase 5. */
const simulatedSender: MailSender = {
  async send(mail) {
    console.log(`[simulated send] to=${mail.to} subject=${JSON.stringify(mail.subject)}`);
  },
};

/**
 * Phase 4 has no authentication, so decisions fail closed unless the operator
 * explicitly opts in via a server-side env flag (never client-influenced —
 * request headers are spoofable). The dev/start scripts additionally bind the
 * server to loopback. Real auth + scoped RLS replace this in phase 5.
 */
async function assertApprovalsEnabled(): Promise<void> {
  if (process.env.TRIAGE_ALLOW_APPROVALS !== '1') {
    throw new Error(
      'approval actions are disabled: set TRIAGE_ALLOW_APPROVALS=1 in the local environment (no dashboard auth until phase 5)',
    );
  }
}

export async function approve(formData: FormData): Promise<void> {
  await assertApprovalsEnabled();
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
    decidedBy: 'dashboard',
  });
  // The queue worker runs inline after a decision — the only send path in the system.
  await processApprovals({ approvals, drafts, messages, audit, sender: simulatedSender });
  revalidatePath('/');
}

export async function reject(formData: FormData): Promise<void> {
  await assertApprovalsEnabled();
  const draftId = String(formData.get('draftId'));
  const { approvals } = stores();
  await approvals.decide(draftId, { status: 'rejected', decidedBy: 'dashboard' });
  revalidatePath('/');
}
