import type {
  Approval,
  ApprovalStore,
  AuditEntry,
  AuditLog,
  CostEntry,
  CostLog,
  DraftRecord,
  DraftStore,
  MailSender,
  MessageStore,
  TriageMessage,
  UpsertResult,
} from '@triage/core';

/** In-memory stores for tests and the credential-free demo. */
export class MemoryStore implements MessageStore {
  private readonly messages = new Map<string, TriageMessage>();

  private key(provider: string, providerMessageId: string): string {
    return `${provider}:${providerMessageId}`;
  }

  async upsertMessage(message: TriageMessage): Promise<UpsertResult> {
    const key = this.key(message.provider, message.providerMessageId);
    if (this.messages.has(key)) return { inserted: false };
    this.messages.set(key, message);
    return { inserted: true };
  }

  async getMessage(provider: string, providerMessageId: string): Promise<TriageMessage | null> {
    return this.messages.get(this.key(provider, providerMessageId)) ?? null;
  }

  async count(): Promise<number> {
    return this.messages.size;
  }
}

export class MemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(): Promise<AuditEntry[]> {
    return [...this.entries];
  }
}

export class MemoryCostLog implements CostLog {
  private readonly entries: CostEntry[] = [];

  async record(entry: CostEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(): Promise<CostEntry[]> {
    return [...this.entries];
  }
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, Approval>();

  /** Mirror of the DB trigger: called by the draft store on every createDraft. */
  createPending(draftId: string): void {
    this.approvals.set(draftId, { draftId, status: 'pending' });
  }

  async list(): Promise<Approval[]> {
    return [...this.approvals.values()].map((a) => ({ ...a }));
  }

  async decide(
    draftId: string,
    decision: { status: 'approved' | 'rejected'; editedBody?: string; decidedBy: string },
  ): Promise<void> {
    const approval = this.approvals.get(draftId);
    if (!approval || approval.status !== 'pending') {
      throw new Error(`approval ${draftId} is not pending`);
    }
    Object.assign(approval, {
      status: decision.status,
      editedBody: decision.editedBody,
      decidedBy: decision.decidedBy,
      decidedAt: new Date().toISOString(),
    });
  }

  async claimForSend(draftId: string): Promise<boolean> {
    const approval = this.approvals.get(draftId);
    if (!approval || approval.status !== 'approved') return false;
    approval.status = 'sending';
    return true;
  }

  async markSent(draftId: string): Promise<void> {
    const approval = this.approvals.get(draftId);
    if (!approval || approval.status !== 'sending') {
      throw new Error(`approval ${draftId} is not in 'sending'`);
    }
    approval.status = 'sent';
    approval.sentAt = new Date().toISOString();
  }
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, DraftRecord>();
  private nextId = 1;

  /** Pass the approval store to mirror the DB trigger: draft insert => pending approval row. */
  constructor(private readonly approvals?: MemoryApprovalStore) {}

  async createDraft(draft: {
    provider: string;
    providerMessageId: string;
    body: string;
  }): Promise<{ draftId: string }> {
    const draftId = `draft-${this.nextId++}`;
    this.drafts.set(draftId, { draftId, createdAt: new Date().toISOString(), ...draft });
    this.approvals?.createPending(draftId);
    return { draftId };
  }

  async getDraft(draftId: string): Promise<DraftRecord | null> {
    const draft = this.drafts.get(draftId);
    return draft ? { ...draft } : null;
  }

  async listDrafts(): Promise<DraftRecord[]> {
    return [...this.drafts.values()].map((d) => ({ ...d }));
  }

  async count(): Promise<number> {
    return this.drafts.size;
  }
}

/** Records sends instead of performing them — tests and the phase-4 simulated queue worker. */
export class MemoryMailSender implements MailSender {
  readonly sends: Parameters<MailSender['send']>[0][] = [];

  async send(mail: Parameters<MailSender['send']>[0]): Promise<void> {
    this.sends.push(mail);
  }
}
