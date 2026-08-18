import type { TriageMessage } from './types.js';

export interface SyncResult {
  messages: TriageMessage[];
  /**
   * Opaque cursor to pass to the next sync() call. Provider-defined:
   * fixture = last receivedAt, Gmail = historyId, Graph = deltaLink.
   * Persist only after the whole page is stored — idempotent upserts make replay safe.
   */
  nextCursor: string | null;
}

/**
 * Mail source abstraction. Implementations: FixtureProvider (local JSON),
 * GmailProvider (live), GraphProvider (roadmap).
 */
export interface MailProvider {
  readonly name: string;
  /**
   * Incremental sync. Omit cursor for a full sync. A provider may throw
   * CursorExpiredError when the cursor is no longer valid (e.g. Gmail
   * historyId expiry); the caller must then full-sync from scratch.
   */
  sync(cursor?: string): Promise<SyncResult>;
}

export class CursorExpiredError extends Error {
  constructor(provider: string) {
    super(`sync cursor expired for provider ${provider}; full sync required`);
    this.name = 'CursorExpiredError';
  }
}
