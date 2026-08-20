import {
  resolveTrustTier,
  type AuditLog,
  type Category,
  type ClassificationVerdict,
  type CostLog,
  type LLMProvider,
  type ToolName,
  type TriageMessage,
  type TrustConfig,
} from '@triage/core';
import { quarantine } from './quarantine.js';
import { DRAFT_SYSTEM_PROMPT, SYSTEM_PROMPT } from './prompt.js';

/** Subset of the MCP SDK Client the loop needs — injectable in tests. */
export interface McpCaller {
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ isError?: boolean; content?: unknown }>;
}

export interface TriageBudget {
  /** Pre-flight cap on estimated input tokens; nothing is spent past it. */
  maxInputTokens: number;
  /** Passed to the API as max_tokens — the output hard kill. */
  maxOutputTokens: number;
  /** max_tokens for the draft pass (stronger model, longer output). */
  maxDraftOutputTokens: number;
  /** Post-flight alert threshold on actual total tokens (catches estimator drift). */
  maxTotalTokens: number;
}

export const DEFAULT_BUDGET: TriageBudget = {
  maxInputTokens: 5_000,
  maxOutputTokens: 512,
  maxDraftOutputTokens: 1_024,
  // Now covers classify + draft cumulatively: worst case ~(5000+512) + (5000+1024).
  maxTotalTokens: 12_000,
};

/** Routine categories the agent may draft replies for. Everything else stays human. */
export const DRAFTABLE_CATEGORIES: readonly Category[] = ['enrolment_query', 'certificate_request'];

export interface TriageDeps {
  llm: LLMProvider;
  mcp: McpCaller;
  costs: CostLog;
  /** System alerts (budget breach) only — tool call auditing lives in the MCP guard. */
  audit: AuditLog;
  budget: TriageBudget;
  /**
   * Trust config for the pre-draft tier gate. Cheap code check that avoids
   * spending draft-model tokens the MCP guard would refuse anyway — the guard
   * remains the enforcement authority.
   */
  trust: TrustConfig;
}

export interface TriageResult {
  providerMessageId: string;
  verdict: ClassificationVerdict | null;
  aborted?: 'INPUT_TOO_LARGE' | 'CLASSIFY_FAILED';
  /** Provider error text for CLASSIFY_FAILED — for operator logs; audit stays sanitized. */
  abortReason?: string;
  /** True when a reply draft was staged for human approval. */
  drafted?: boolean;
  /** Tool calls that returned isError — surfaced, never swallowed. */
  actionErrors?: { tool: ToolName; code: string }[];
}

const PROMPT_OVERHEAD_TOKENS = 400;

// ponytail: chars/2 is deliberately conservative — English runs ~4 chars/token, but
// adversarial unicode can exceed 1 token/char, so no char heuristic is a true bound.
// Legit long emails hit the cap early and escalate to a human (fail closed, no spend).
// Upgrade path: provider-side token counting endpoints if false escalations matter.
function estimateInputTokens(userText: string): number {
  return Math.ceil(userText.length / 2) + PROMPT_OVERHEAD_TOKENS;
}

/**
 * One message through the pipeline: quarantine → classify (zero tools) →
 * suspicion override → act through the guarded MCP tools. Every branch is
 * code-driven; the model only ever produces the verdict.
 */
export async function triageMessage(
  deps: TriageDeps,
  message: TriageMessage,
): Promise<TriageResult> {
  const { provider, providerMessageId } = message;
  const target = { provider, providerMessageId };
  const actionErrors: { tool: ToolName; code: string }[] = [];

  const call = async (tool: ToolName, args: Record<string, unknown>): Promise<void> => {
    let result;
    try {
      result = await deps.mcp.callTool({ name: tool, arguments: args });
    } catch {
      // A transport throw must not abort the remaining actions (e.g. skip escalation).
      actionErrors.push({ tool, code: 'TRANSPORT_ERROR' });
      return;
    }
    if (result.isError) {
      const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? '{}';
      let code = 'UNKNOWN';
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? 'UNKNOWN';
      } catch {
        // non-JSON refusal payload; keep UNKNOWN
      }
      actionErrors.push({ tool, code });
    }
  };

  const escalate = (reason: string, flags?: string[]) =>
    call('triage_escalate', { ...target, reason, ...(flags ? { flags } : {}) });

  const user = quarantine(message);

  // Pre-flight hard cap: kill before any spend.
  if (estimateInputTokens(user) > deps.budget.maxInputTokens) {
    await deps.audit.record({
      actor: 'system',
      action: 'token_budget_breach',
      phase: 'attempt',
      allowed: false,
      provider,
      providerMessageId,
      detail: { kind: 'input_too_large', inputChars: user.length },
    });
    await escalate('token budget: input too large to classify');
    return { providerMessageId, verdict: null, aborted: 'INPUT_TOO_LARGE', actionErrors };
  }

  let outcome;
  try {
    outcome = await deps.llm.classify({
      system: SYSTEM_PROMPT,
      user,
      maxOutputTokens: deps.budget.maxOutputTokens,
    });
  } catch (e) {
    const abortReason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    await escalate(`classification failed: ${abortReason}`);
    return {
      providerMessageId,
      verdict: null,
      aborted: 'CLASSIFY_FAILED',
      abortReason,
      actionErrors,
    };
  }

  const recordCost = async (
    stage: 'classify' | 'draft',
    usage: typeof outcome.usage,
  ): Promise<void> => {
    try {
      await deps.costs.record({
        provider,
        providerMessageId,
        stage,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usd: usage.usd,
      });
    } catch {
      // Spend already happened; losing the cost row must not abort routing. Best-effort alert.
      await deps.audit
        .record({
          actor: 'system',
          action: 'cost_log_failure',
          phase: 'outcome',
          allowed: true,
          provider,
          providerMessageId,
          detail: { stage, ...usage },
        })
        .catch(() => {});
    }
  };

  const { usage } = outcome;
  await recordCost('classify', usage);
  // Cumulative per-message spend across classify + draft. Breach is an alert,
  // not a kill: spend is already bounded by the per-pass max_tokens caps.
  let totalTokens = 0;
  const checkTotal = async (stage: 'classify' | 'draft', u: typeof usage): Promise<void> => {
    totalTokens += u.inputTokens + u.outputTokens;
    if (totalTokens > deps.budget.maxTotalTokens) {
      await deps.audit.record({
        actor: 'system',
        action: 'token_budget_breach',
        phase: 'outcome',
        allowed: true,
        provider,
        providerMessageId,
        detail: { kind: 'actual_over_total', stage, totalTokens, ...u },
      });
    }
  };
  await checkTotal('classify', usage);

  const verdict = { ...outcome.verdict };
  if (Object.values(verdict.suspicion).some(Boolean) && verdict.category !== 'suspicious') {
    verdict.category = 'suspicious';
    verdict.rationale = `[flag override] ${verdict.rationale}`.slice(0, 300);
  }

  // Deterministic action order: escalation first so a later failure can't suppress it.
  if (verdict.category === 'suspicious') {
    const flags = Object.entries(verdict.suspicion)
      .filter(([, v]) => v)
      .map(([k]) => k);
    await escalate(`suspicious message; flags: ${flags.join(', ') || 'none'}`, flags);
  }
  await call('triage_log_decision', {
    ...target,
    decision: `${verdict.category}/${verdict.urgency}`,
    rationale: verdict.rationale,
  });
  await call('email_apply_label', { ...target, label: verdict.category });

  // Draft pass: tier 2 + routine category + clean verdict only. All three gates
  // are code; suspicious messages were escalated above and are never drafted.
  let drafted = false;
  if (
    verdict.category !== 'suspicious' &&
    DRAFTABLE_CATEGORIES.includes(verdict.category) &&
    resolveTrustTier(message, deps.trust) === 2
  ) {
    // Pre-flight on the cumulative budget: don't start a draft the message's
    // total budget can't cover. The message is already classified and labeled;
    // it just goes out undrafted.
    const projected = totalTokens + estimateInputTokens(user) + deps.budget.maxDraftOutputTokens;
    if (projected > deps.budget.maxTotalTokens) {
      await deps.audit.record({
        actor: 'system',
        action: 'token_budget_breach',
        phase: 'attempt',
        allowed: false,
        provider,
        providerMessageId,
        detail: { kind: 'draft_skipped_over_total', totalTokens, projected },
      });
    } else {
      try {
        const draft = await deps.llm.draftReply({
          system: DRAFT_SYSTEM_PROMPT,
          user,
          maxOutputTokens: deps.budget.maxDraftOutputTokens,
        });
        await recordCost('draft', draft.usage);
        await checkTotal('draft', draft.usage);
        await call('email_draft_reply', { ...target, body: draft.body });
        drafted = !actionErrors.some((e) => e.tool === 'email_draft_reply');
      } catch {
        // Draft failure never undoes the classification actions already taken.
        actionErrors.push({ tool: 'email_draft_reply', code: 'DRAFT_FAILED' });
      }
    }
  }

  return {
    providerMessageId,
    verdict,
    ...(drafted ? { drafted } : {}),
    ...(actionErrors.length ? { actionErrors } : {}),
  };
}
