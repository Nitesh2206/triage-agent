import type { TrustTier } from './types.js';

/**
 * One audited event. Two-phase for tool calls: an 'authorization' entry is
 * written BEFORE execution (if that write fails, the tool must not run),
 * an 'outcome' entry after. 'attempt' covers calls that never reached
 * authorization (e.g. unknown message).
 *
 * detail is sanitized by callers: references and lengths only — never draft
 * text or raw message bodies. Content lives in its own RLS-protected tables.
 */
export interface AuditEntry {
  actor: 'agent' | 'human' | 'system';
  action: string;
  phase: 'authorization' | 'outcome' | 'attempt';
  allowed: boolean;
  outcome?: 'ok' | 'error' | 'refused';
  trustTier?: TrustTier;
  provider?: string;
  providerMessageId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditLog {
  /** Must throw on persistence failure — callers rely on that to fail closed. */
  record(entry: AuditEntry): Promise<void>;
  list(): Promise<AuditEntry[]>;
}
