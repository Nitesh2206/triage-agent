import {
  resolveTrustTier,
  TOOL_MIN_TIER,
  type AuditLog,
  type MessageStore,
  type ToolName,
  type TriageMessage,
  type TrustConfig,
  type TrustTier,
} from '@triage/core';

export interface GuardDeps {
  messages: MessageStore;
  audit: AuditLog;
  trust: TrustConfig;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;

  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function refuse(code: string, reason: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, reason }) }] };
}

/**
 * Fail-closed authorization wrapper around every tool handler.
 *
 * Chain: lookup message → resolve tier → policy check → authorization audit row
 * → execute → outcome audit row.
 *
 * Invariants:
 * - the handler NEVER runs unless the authorization audit row was persisted
 * - refusals and unknown-message attempts are audited, not silently dropped
 * - handler failures are audited as outcome 'error'
 * - `safeDetail` must already be sanitized (no message bodies, no draft text)
 */
export async function guarded(
  deps: GuardDeps,
  tool: ToolName,
  args: { provider: string; providerMessageId: string },
  safeDetail: Record<string, unknown>,
  exec: (message: TriageMessage, tier: TrustTier) => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  const { provider, providerMessageId } = args;

  const message = await deps.messages.getMessage(provider, providerMessageId);
  if (!message) {
    try {
      await deps.audit.record({
        actor: 'agent',
        action: tool,
        phase: 'attempt',
        allowed: false,
        provider,
        providerMessageId,
        detail: { code: 'UNKNOWN_MESSAGE' },
      });
    } catch {
      // The call is already being rejected; a failed attempt-audit must not mask that.
    }
    return refuse('UNKNOWN_MESSAGE', `no message ${providerMessageId} for provider ${provider}`);
  }

  const tier = resolveTrustTier(message, deps.trust);
  const minTier = TOOL_MIN_TIER[tool];
  const allowed = tier >= minTier;

  try {
    await deps.audit.record({
      actor: 'agent',
      action: tool,
      phase: 'authorization',
      allowed,
      outcome: allowed ? undefined : 'refused',
      trustTier: tier,
      provider,
      providerMessageId,
      detail: safeDetail,
    });
  } catch {
    // No audit, no action.
    return refuse('AUDIT_UNAVAILABLE', 'audit persistence failed; refusing to execute');
  }

  if (!allowed) {
    return refuse(
      'POLICY_DENIED',
      `${tool} requires trust tier ${minTier}; sender is tier ${tier}`,
    );
  }

  let result: Record<string, unknown>;
  try {
    result = await exec(message, tier);
  } catch (e) {
    try {
      await deps.audit.record({
        actor: 'agent',
        action: tool,
        phase: 'outcome',
        allowed: true,
        outcome: 'error',
        trustTier: tier,
        provider,
        providerMessageId,
        detail: { error: e instanceof Error ? e.message : String(e) },
      });
    } catch {
      // Outcome-audit failure must not mask the tool error itself.
    }
    return refuse('TOOL_FAILED', e instanceof Error ? e.message : String(e));
  }

  // The effect succeeded. An outcome-audit failure past this point must NOT
  // surface as a tool error — that would invite the caller to retry an action
  // that already happened (duplicate drafts/cards). The authorization row is
  // already persisted, so the call remains traceable.
  try {
    await deps.audit.record({
      actor: 'agent',
      action: tool,
      phase: 'outcome',
      allowed: true,
      outcome: 'ok',
      trustTier: tier,
      provider,
      providerMessageId,
      detail: { ...safeDetail, ...result },
    });
  } catch {
    return ok({ ...result, auditIncomplete: true });
  }
  return ok(result);
}
