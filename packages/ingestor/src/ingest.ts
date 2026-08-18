import type { MailProvider, MessageStore } from '@triage/core';

export interface IngestReport {
  fetched: number;
  inserted: number;
  skipped: number;
  /**
   * Cursor for the next run. Persist only after this run fully succeeds —
   * idempotent upserts make replaying a page safe.
   */
  nextCursor: string | null;
}

/** One ingest run: sync from cursor, store idempotently. Safe to rerun/replay. */
export async function ingest(
  provider: MailProvider,
  store: MessageStore,
  cursor?: string,
): Promise<IngestReport> {
  const { messages, nextCursor } = await provider.sync(cursor);
  let inserted = 0;
  for (const message of messages) {
    const result = await store.upsertMessage(message);
    if (result.inserted) inserted++;
  }
  return { fetched: messages.length, inserted, skipped: messages.length - inserted, nextCursor };
}
