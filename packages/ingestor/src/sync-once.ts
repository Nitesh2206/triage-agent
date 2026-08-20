import {
  CursorExpiredError,
  type MailProvider,
  type MessageStore,
  type SyncStateStore,
} from '@triage/core';
import { ingest, type IngestReport } from './ingest.js';

export type SyncOnceResult = { ran: true; report: IngestReport } | { ran: false; reason: string };

const BACKOFF_CAP_MINUTES = 60;

/**
 * One cursor-aware ingest run. Order matters for crash safety: the page is
 * fully stored by ingest() BEFORE the cursor advances — a crash in between
 * replays the page next run, and idempotent upserts make that a no-op.
 * An expired cursor (Gmail historyId aged out) falls back to a full resync.
 * Failures back off exponentially (2^n minutes, capped) via sync_state.
 */
export async function syncOnce(
  provider: MailProvider,
  messages: MessageStore,
  syncState: SyncStateStore,
  now: () => Date = () => new Date(),
): Promise<SyncOnceResult> {
  const state = await syncState.get(provider.name);
  if (state?.nextRetryAt && now() < new Date(state.nextRetryAt)) {
    return { ran: false, reason: `backing off until ${state.nextRetryAt}` };
  }

  try {
    let report: IngestReport;
    try {
      report = await ingest(provider, messages, state?.cursor ?? undefined);
    } catch (e) {
      if (!(e instanceof CursorExpiredError)) throw e;
      report = await ingest(provider, messages, undefined);
    }
    await syncState.set(provider.name, {
      cursor: report.nextCursor,
      failureCount: 0,
      nextRetryAt: null,
    });
    return { ran: true, report };
  } catch (e) {
    const failureCount = (state?.failureCount ?? 0) + 1;
    const minutes = Math.min(2 ** failureCount, BACKOFF_CAP_MINUTES);
    await syncState.set(provider.name, {
      cursor: state?.cursor ?? null,
      failureCount,
      nextRetryAt: new Date(now().getTime() + minutes * 60_000).toISOString(),
    });
    throw e;
  }
}
