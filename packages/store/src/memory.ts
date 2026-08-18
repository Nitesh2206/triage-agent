import type {
  AuditEntry,
  AuditLog,
  DraftStore,
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

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, { provider: string; providerMessageId: string; body: string }>();
  private nextId = 1;

  async createDraft(draft: {
    provider: string;
    providerMessageId: string;
    body: string;
  }): Promise<{ draftId: string }> {
    const draftId = `draft-${this.nextId++}`;
    this.drafts.set(draftId, draft);
    return { draftId };
  }

  async count(): Promise<number> {
    return this.drafts.size;
  }
}
