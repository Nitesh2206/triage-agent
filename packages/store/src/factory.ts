import { createClient } from '@supabase/supabase-js';
import type {
  ApprovalStore,
  AuditLog,
  CostLog,
  DraftStore,
  MessageStore,
  SyncStateStore,
} from '@triage/core';
import {
  MemoryApprovalStore,
  MemoryAuditLog,
  MemoryCostLog,
  MemoryDraftStore,
  MemoryStore,
  MemorySyncStateStore,
} from './memory.js';
import {
  SupabaseApprovalStore,
  SupabaseAuditLog,
  SupabaseCostLog,
  SupabaseDraftStore,
  SupabaseStore,
  SupabaseSyncStateStore,
} from './supabase.js';

export interface Stores {
  backend: 'supabase' | 'memory';
  messages: MessageStore;
  audit: AuditLog;
  drafts: DraftStore;
  approvals: ApprovalStore;
  costs: CostLog;
  syncState: SyncStateStore;
}

/**
 * Supabase-backed set when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are present,
 * in-memory set otherwise (credential-free demo). Service role bypasses RLS —
 * server-side only, never ship this key to a browser.
 */
export function createStores(env: Record<string, string | undefined> = process.env): Stores {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const client = createClient(url, key);
    return {
      backend: 'supabase',
      messages: new SupabaseStore(client),
      audit: new SupabaseAuditLog(client),
      drafts: new SupabaseDraftStore(client),
      approvals: new SupabaseApprovalStore(client),
      costs: new SupabaseCostLog(client),
      syncState: new SupabaseSyncStateStore(client),
    };
  }
  const approvals = new MemoryApprovalStore();
  return {
    backend: 'memory',
    messages: new MemoryStore(),
    audit: new MemoryAuditLog(),
    drafts: new MemoryDraftStore(approvals),
    approvals,
    costs: new MemoryCostLog(),
    syncState: new MemorySyncStateStore(),
  };
}
