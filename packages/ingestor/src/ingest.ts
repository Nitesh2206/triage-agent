import type { MailProvider, MessageStore } from '@triage/core';

export interface IngestReport {
  fetched: number;
  inserted: number;
  skipped: number;
}

/** One ingest run: fetch new messages, store idempotently. Safe to rerun. */
export async function ingest(
  provider: MailProvider,
  store: MessageStore,
  since?: string,
): Promise<IngestReport> {
  const messages = await provider.listNewMessages(since);
  let inserted = 0;
  for (const message of messages) {
    const result = await store.upsertMessage(message);
    if (result.inserted) inserted++;
  }
  return { fetched: messages.length, inserted, skipped: messages.length - inserted };
}
