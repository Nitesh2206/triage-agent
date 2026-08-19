import { describe, expect, it } from 'vitest';
import { processApprovals, type TriageMessage } from '@triage/core';
import {
  MemoryApprovalStore,
  MemoryAuditLog,
  MemoryDraftStore,
  MemoryMailSender,
  MemoryStore,
} from '../src/memory.js';

const message: TriageMessage = {
  provider: 'fixture',
  providerMessageId: 'fx-a1',
  providerThreadId: 'thread-9',
  from: { address: 'sarah@example.com' },
  to: [{ address: 'admin@brightpath.edu.au' }],
  subject: 'Enrolment question',
  receivedAt: '2026-08-19T00:00:00Z',
  body: 'When does the course start?',
  authenticity: { dmarc: 'pass', alignedDomain: 'example.com' },
};

async function setup() {
  const approvals = new MemoryApprovalStore();
  const drafts = new MemoryDraftStore(approvals);
  const messages = new MemoryStore();
  const audit = new MemoryAuditLog();
  const sender = new MemoryMailSender();
  await messages.upsertMessage(message);
  const { draftId } = await drafts.createDraft({
    provider: 'fixture',
    providerMessageId: 'fx-a1',
    body: 'Draft reply body.',
  });
  return { approvals, drafts, messages, audit, sender, draftId };
}

describe('draft/approval lifecycle', () => {
  it('creating a draft creates its pending approval atomically', async () => {
    const { approvals, draftId } = await setup();
    expect(await approvals.list()).toEqual([{ draftId, status: 'pending' }]);
  });

  it('decide is only valid from pending', async () => {
    const { approvals, draftId } = await setup();
    await approvals.decide(draftId, { status: 'rejected', decidedBy: 'ops' });
    await expect(approvals.decide(draftId, { status: 'approved', decidedBy: 'ops' })).rejects.toThrow(
      /not pending/,
    );
  });
});

describe('processApprovals', () => {
  it('approved draft: sends to source sender on source thread, marks sent, audits', async () => {
    const { approvals, drafts, messages, audit, sender, draftId } = await setup();
    await approvals.decide(draftId, { status: 'approved', decidedBy: 'ops' });

    const report = await processApprovals({ approvals, drafts, messages, audit, sender });

    expect(report).toEqual({ sent: [draftId], failed: [] });
    expect(sender.sends).toEqual([
      {
        to: 'sarah@example.com',
        subject: 'Re: Enrolment question',
        body: 'Draft reply body.',
        providerThreadId: 'thread-9',
      },
    ]);
    const [approval] = await approvals.list();
    expect(approval.status).toBe('sent');
    expect(approval.sentAt).toBeDefined();
    const sendRows = (await audit.list()).filter((e) => e.action === 'email_send');
    // Two-phase: authorization persisted BEFORE the send, outcome after.
    expect(sendRows.map((e) => e.phase)).toEqual(['authorization', 'outcome']);
    expect(sendRows[1]).toMatchObject({
      actor: 'human',
      allowed: true,
      outcome: 'ok',
      providerMessageId: 'fx-a1',
    });
    // Sanitized: body text never lands in the audit log.
    expect(JSON.stringify(sendRows.map((e) => e.detail))).not.toContain('Draft reply body');
  });

  it('edited body wins over the agent draft', async () => {
    const { approvals, drafts, messages, audit, sender, draftId } = await setup();
    await approvals.decide(draftId, { status: 'approved', editedBody: 'Human version.', decidedBy: 'ops' });
    await processApprovals({ approvals, drafts, messages, audit, sender });
    expect(sender.sends[0].body).toBe('Human version.');
  });

  it('pending and rejected rows are untouched', async () => {
    const { approvals, drafts, messages, audit, sender } = await setup();
    const second = await drafts.createDraft({
      provider: 'fixture',
      providerMessageId: 'fx-a1',
      body: 'Another draft.',
    });
    await approvals.decide(second.draftId, { status: 'rejected', decidedBy: 'ops' });

    const report = await processApprovals({ approvals, drafts, messages, audit, sender });

    expect(report.sent).toEqual([]);
    expect(sender.sends).toEqual([]);
    const statuses = (await approvals.list()).map((a) => a.status).sort();
    expect(statuses).toEqual(['pending', 'rejected']);
  });

  it('sender failure: not marked sent, stays in sending for operator review', async () => {
    const { approvals, drafts, messages, audit, draftId } = await setup();
    await approvals.decide(draftId, { status: 'approved', decidedBy: 'ops' });
    const broken = {
      send: async () => {
        throw new Error('smtp down');
      },
    };

    const report = await processApprovals({ approvals, drafts, messages, audit, sender: broken });

    expect(report.sent).toEqual([]);
    expect(report.failed).toEqual([{ draftId, reason: 'smtp down' }]);
    expect((await approvals.list())[0].status).toBe('sending');
    const row = (await audit.list()).find((e) => e.action === 'email_send' && e.phase === 'outcome');
    expect(row?.outcome).toBe('error');
  });

  it('audit unavailable: send blocked, row stays claimed for operator review', async () => {
    const { approvals, drafts, messages, sender, draftId } = await setup();
    await approvals.decide(draftId, { status: 'approved', decidedBy: 'ops' });
    const deadAudit = {
      record: async () => {
        throw new Error('db down');
      },
      list: async () => [],
    };

    const report = await processApprovals({ approvals, drafts, messages, audit: deadAudit, sender });

    expect(sender.sends).toEqual([]);
    expect(report.sent).toEqual([]);
    expect(report.failed[0].reason).toMatch(/audit unavailable/);
  });

  it('a claimed draft cannot be sent twice', async () => {
    const { approvals, drafts, messages, audit, sender, draftId } = await setup();
    await approvals.decide(draftId, { status: 'approved', decidedBy: 'ops' });
    await processApprovals({ approvals, drafts, messages, audit, sender });
    const again = await processApprovals({ approvals, drafts, messages, audit, sender });
    expect(again.sent).toEqual([]);
    expect(sender.sends).toHaveLength(1);
  });
});
