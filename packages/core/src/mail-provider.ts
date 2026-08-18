import type { TriageMessage } from './types.js';

/**
 * Mail source abstraction. Implementations: FixtureProvider (local JSON),
 * GmailProvider (live), GraphProvider (roadmap).
 */
export interface MailProvider {
  readonly name: string;
  /** Messages received after `since` (ISO 8601). Omit for everything. */
  listNewMessages(since?: string): Promise<TriageMessage[]>;
}
