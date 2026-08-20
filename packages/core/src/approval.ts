import type { AuditLog } from './audit.js';
import type { DraftStore } from './draft-store.js';
import type { MessageStore } from './message-store.js';

/**
 * Human approval of a staged draft. One row per draft, created atomically with
 * the draft (DB trigger / store parity) so a draft can never exist unreviewed.
 * Lifecycle: pending → approved|rejected; approved → sending → sent.
 * The 'sending' claim is atomic so two workers cannot send the same draft.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'sending' | 'sent';

export interface Approval {
  draftId: string;
  status: ApprovalStatus;
  /** Human-edited body; when set, this is what gets sent, not the agent's draft. */
  editedBody?: string;
  decidedBy?: string;
  decidedAt?: string;
  sentAt?: string;
  /** Our own RFC 5322 Message-ID, persisted BEFORE the send — the idempotency key. */
  sendMessageId?: string;
  /** Provider's id of the sent message (audit trail). */
  providerSendId?: string;
  /** When the current send attempt started; the recovery hold window measures from here. */
  sendingAt?: string;
}

export interface ApprovalStore {
  list(): Promise<Approval[]>;
  /** Valid only from 'pending'; must throw on any other current status. */
  decide(
    draftId: string,
    decision: { status: 'approved' | 'rejected'; editedBody?: string; decidedBy: string },
  ): Promise<void>;
  /** Atomic approved → sending transition. False = someone else claimed it or status moved on. */
  claimForSend(draftId: string): Promise<boolean>;
  /** Persist the send Message-ID on a 'sending' row and stamp sendingAt — called before EVERY provider attempt. */
  setSendMessageId(draftId: string, sendMessageId: string): Promise<void>;
  markSent(draftId: string, providerSendId?: string): Promise<void>;
}

/** Outbound mail. Simulated in demos; GmailSender in production. */
export interface MailSender {
  send(mail: {
    to: string;
    subject: string;
    body: string;
    /** Our RFC 5322 Message-ID — the sender MUST stamp it on the outgoing message. */
    messageId: string;
    providerThreadId?: string;
  }): Promise<{ providerSendId?: string }>;
  /**
   * Recovery probe: did a message with this Message-ID already leave?
   * Optional — without it, stuck 'sending' rows stay for human resolution.
   * Best-effort (provider search is eventually consistent); see processApprovals.
   */
  findSent?(messageId: string): Promise<boolean>;
}

export interface ApprovalWorkerDeps {
  approvals: ApprovalStore;
  drafts: DraftStore;
  messages: MessageStore;
  audit: AuditLog;
  sender: MailSender;
}

export interface SendReport {
  sent: string[];
  /** Drafts that were approved but could not be sent this run (kept 'sending' for operator review). */
  failed: { draftId: string; reason: string }[];
}

export interface ApprovalWorkerOptions {
  /**
   * Minimum age (from decision time) before a stuck 'sending' row may be
   * re-sent. Provider search is eventually consistent — a just-sent message
   * can be temporarily unfindable, so recovery holds off rather than risk a
   * duplicate. Best-effort idempotency, not a guarantee (see threat model).
   */
  holdMs?: number;
  now?: () => Date;
}

const DEFAULT_HOLD_MS = Number(process.env.TRIAGE_SEND_HOLD_MINUTES ?? 30) * 60_000;

/**
 * The approval queue worker — the ONLY send path in the system. The agent has
 * no send tool at any trust tier. Send scope is enforced here in code: the
 * reply goes to the source message's sender on the source thread, nothing else.
 *
 * Send idempotency: we author the outgoing RFC 5322 Message-ID and persist it
 * on the approval row BEFORE calling the provider. A crash between send and
 * markSent leaves a 'sending' row WITH a send id; the recovery pass below
 * probes the provider for that id — found means the mail left (mark sent, no
 * resend), not found after the hold window means it never left (safe to
 * resend with the same id).
 */
export async function processApprovals(
  deps: ApprovalWorkerDeps,
  opts: ApprovalWorkerOptions = {},
): Promise<SendReport> {
  const report: SendReport = { sent: [], failed: [] };
  const now = opts.now ?? (() => new Date());
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
  const all = await deps.approvals.list();

  // Recovery pass: rows stuck in 'sending' from a crashed prior run.
  for (const stuck of all.filter((a) => a.status === 'sending' && a.sendMessageId)) {
    if (!deps.sender.findSent) continue; // simulated sender: human resolves on the dashboard
    try {
      if (await deps.sender.findSent(stuck.sendMessageId!)) {
        await deps.approvals.markSent(stuck.draftId);
        report.sent.push(stuck.draftId);
        continue;
      }
      // Hold measured from the send ATTEMPT, not the approval decision — an
      // old approval whose first attempt just crashed must still wait out the
      // provider's search lag. Missing timestamp -> hold (fail closed).
      const attemptedAt = stuck.sendingAt ?? stuck.decidedAt;
      if (!attemptedAt || now().getTime() - Date.parse(attemptedAt) < holdMs) continue;
      // Re-stamp sendingAt for this new attempt; the Message-ID is reused.
      await deps.approvals.setSendMessageId(stuck.draftId, stuck.sendMessageId!);
      await sendOne(deps, stuck, report, stuck.sendMessageId!);
    } catch (e) {
      report.failed.push({
        draftId: stuck.draftId,
        reason: `recovery failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  for (const approval of all.filter((a) => a.status === 'approved')) {
    if (!(await deps.approvals.claimForSend(approval.draftId))) continue;
    // The idempotency key is durable before the provider ever sees the mail.
    const sendMessageId = `<draft-${approval.draftId}-${crypto.randomUUID()}@triage>`;
    try {
      await deps.approvals.setSendMessageId(approval.draftId, sendMessageId);
    } catch (e) {
      report.failed.push({
        draftId: approval.draftId,
        reason: `send id not persisted, send blocked: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    await sendOne(deps, approval, report, sendMessageId);
  }
  return report;
}

async function sendOne(
  deps: ApprovalWorkerDeps,
  approval: Approval,
  report: SendReport,
  sendMessageId: string,
): Promise<void> {
  const fail = async (reason: string): Promise<void> => {
    report.failed.push({ draftId: approval.draftId, reason });
    await deps.audit
      .record({
        actor: 'system',
        action: 'email_send',
        phase: 'outcome',
        allowed: true,
        outcome: 'error',
        detail: { draftId: approval.draftId, reason },
      })
      .catch(() => {});
  };

  const draft = await deps.drafts.getDraft(approval.draftId);
  if (!draft) {
    await fail('draft not found');
    return;
  }
  const message = await deps.messages.getMessage(draft.provider, draft.providerMessageId);
  if (!message) {
    await fail('source message not found');
    return;
  }

  const body = approval.editedBody ?? draft.body;
  const detail = {
    draftId: approval.draftId,
    edited: approval.editedBody !== undefined,
    bodyLength: body.length,
    sendMessageId,
  };

  // Two-phase like the MCP guard: the authorization row lands BEFORE the
  // send — if it cannot be persisted, the send does not happen. No message
  // ever leaves without a durable audit trace.
  try {
    await deps.audit.record({
      actor: 'human',
      action: 'email_send',
      phase: 'authorization',
      allowed: true,
      provider: draft.provider,
      providerMessageId: draft.providerMessageId,
      detail,
    });
  } catch (e) {
    report.failed.push({
      draftId: approval.draftId,
      reason: `audit unavailable, send blocked: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  let providerSendId: string | undefined;
  try {
    // Thread scope: recipient and thread references come from the stored
    // source message only — nothing the model produced can redirect a send.
    // RFC In-Reply-To is resolved by the sender from providerThreadId (the
    // envelope doesn't carry the source's own Message-ID).
    const result = await deps.sender.send({
      to: message.from.address,
      subject: `Re: ${message.subject}`,
      body,
      messageId: sendMessageId,
      providerThreadId: message.providerThreadId,
    });
    providerSendId = result?.providerSendId;
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
    return;
  }

  await deps.approvals.markSent(approval.draftId, providerSendId);
  report.sent.push(approval.draftId);
  // Outcome row is best-effort: the send already happened and is covered by
  // the authorization row; a logging hiccup must not fail the worker.
  await deps.audit
    .record({
      actor: 'human',
      action: 'email_send',
      phase: 'outcome',
      allowed: true,
      outcome: 'ok',
      provider: draft.provider,
      providerMessageId: draft.providerMessageId,
      detail: { ...detail, providerSendId },
    })
    .catch((e: unknown) => {
      report.failed.push({
        draftId: approval.draftId,
        reason: `sent, but outcome audit failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
}
