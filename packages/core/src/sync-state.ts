/**
 * Per-provider sync cursor + retry state (sync_state table / memory map).
 * Contract: store the whole page of messages first, then set the cursor —
 * idempotent upserts make replaying a partially-processed page safe.
 */
export interface SyncState {
  cursor: string | null;
  failureCount: number;
  nextRetryAt: string | null;
}

export interface SyncStateStore {
  get(provider: string): Promise<SyncState | null>;
  set(provider: string, state: SyncState): Promise<void>;
}
