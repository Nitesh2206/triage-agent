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
  markSent(draftId: string): Promise<void>;
}

/** Outbound mail. Phase 4 implementation is simulated; real Gmail send arrives in phase 5. */
export interface MailSender {
  send(mail: {
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string;
    providerThreadId?: string;
  }): Promise<void>;
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

/**
 * The approval queue worker — the ONLY send path in the system. The agent has
 * no send tool at any trust tier. Send scope is enforced here in code: the
 * reply goes to the source message's sender on the source thread, nothing else.
 */
// ponytail: no provider-side idempotency key yet — a crash between send() and
// markSent() leaves the row 'sending' (visible on the dashboard, human resolves).
// Phase 5's real Gmail sender adds a provider send id to make retries safe.
export async function processApprovals(deps: ApprovalWorkerDeps): Promise<SendReport> {
  const report: SendReport = { sent: [], failed: [] };
  const approved = (await deps.approvals.list()).filter((a) => a.status === 'approved');

  for (const approval of approved) {
    if (!(await deps.approvals.claimForSend(approval.draftId))) continue;

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
      continue;
    }
    const message = await deps.messages.getMessage(draft.provider, draft.providerMessageId);
    if (!message) {
      await fail('source message not found');
      continue;
    }

    const body = approval.editedBody ?? draft.body;
    const detail = {
      draftId: approval.draftId,
      edited: approval.editedBody !== undefined,
      bodyLength: body.length,
      simulated: true,
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
      continue;
    }

    try {
      // Thread scope: recipient and thread references come from the stored
      // source message only — nothing the model produced can redirect a send.
      // RFC In-Reply-To needs the source's own Message-ID, which the envelope
      // doesn't carry; the phase-5 Gmail sender resolves it from providerThreadId.
      await deps.sender.send({
        to: message.from.address,
        subject: `Re: ${message.subject}`,
        body,
        providerThreadId: message.providerThreadId,
      });
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
      continue;
    }

    await deps.approvals.markSent(approval.draftId);
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
        detail,
      })
      .catch((e: unknown) => {
        report.failed.push({
          draftId: approval.draftId,
          reason: `sent, but outcome audit failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
  }
  return report;
}
