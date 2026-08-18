import type { TrustTier } from './types.js';

/** Minimum sender trust tier required per tool. Enforced by the MCP server middleware. */
// Underscored names: MCP tool names must match [a-zA-Z0-9_-]+ (no dots).
export const TOOL_MIN_TIER = {
  email_apply_label: 0,
  triage_escalate: 0,
  triage_log_decision: 0,
  trello_create_card: 1,
  email_draft_reply: 2,
} as const satisfies Record<string, TrustTier>;

export type ToolName = keyof typeof TOOL_MIN_TIER;
