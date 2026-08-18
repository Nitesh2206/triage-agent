import type { MessageStore, TriageMessage, UpsertResult } from '@triage/core';

/** In-memory store for tests and the credential-free demo. */
export class MemoryStore implements MessageStore {
  private readonly messages = new Map<string, TriageMessage>();

  async upsertMessage(message: TriageMessage): Promise<UpsertResult> {
    const key = `${message.provider}:${message.providerMessageId}`;
    if (this.messages.has(key)) return { inserted: false };
    this.messages.set(key, message);
    return { inserted: true };
  }

  async count(): Promise<number> {
    return this.messages.size;
  }
}
