import type {
  AuditLog,
  ClassificationVerdict,
  CostLog,
  LLMProvider,
  ToolName,
  TriageMessage,
} from '@triage/core';
import { quarantine } from './quarantine.js';
import { SYSTEM_PROMPT } from './prompt.js';

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
  /** Post-flight alert threshold on actual total tokens (catches estimator drift). */
  maxTotalTokens: number;
}

export const DEFAULT_BUDGET: TriageBudget = {
  maxInputTokens: 5_000,
  maxOutputTokens: 512,
  maxTotalTokens: 8_000,
};

export interface TriageDeps {
  llm: LLMProvider;
  mcp: McpCaller;
  costs: CostLog;
  /** System alerts (budget breach) only — tool call auditing lives in the MCP guard. */
  audit: AuditLog;
  budget: TriageBudget;
}

export interface TriageResult {
  providerMessageId: string;
  verdict: ClassificationVerdict | null;
  aborted?: 'INPUT_TOO_LARGE' | 'CLASSIFY_FAILED';
  /** Tool calls that returned isError — surfaced, never swallowed. */
  actionErrors?: { tool: ToolName; code: string }[];
}

/** chars/4 underestimates adversarial input, so a fixed overhead pads the prompt side. */
const PROMPT_OVERHEAD_TOKENS = 400;

function estimateInputTokens(userText: string): number {
  return Math.ceil(userText.length / 4) + PROMPT_OVERHEAD_TOKENS;
}

/**
 * One message through the pipeline: quarantine → classify (zero tools) →
 * suspicion override → act through the guarded MCP tools. Every branch is
 * code-driven; the model only ever produces the verdict.
 */
export async function triageMessage(deps: TriageDeps, message: TriageMessage): Promise<TriageResult> {
  const { provider, providerMessageId } = message;
  const target = { provider, providerMessageId };
  const actionErrors: { tool: ToolName; code: string }[] = [];

  const call = async (tool: ToolName, args: Record<string, unknown>): Promise<void> => {
    const result = await deps.mcp.callTool({ name: tool, arguments: args });
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

  const escalate = (reason: string) => call('triage_escalate', { ...target, reason });

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
    await escalate(
      `classification failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
    );
    return { providerMessageId, verdict: null, aborted: 'CLASSIFY_FAILED', actionErrors };
  }

  const { usage } = outcome;
  await deps.costs.record({
    provider,
    providerMessageId,
    stage: 'classify',
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usd: usage.usd,
  });
  if (usage.inputTokens + usage.outputTokens > deps.budget.maxTotalTokens) {
    // Spend already happened and is bounded by the pre-flight caps; alert, don't discard.
    await deps.audit.record({
      actor: 'system',
      action: 'token_budget_breach',
      phase: 'outcome',
      allowed: true,
      provider,
      providerMessageId,
      detail: { kind: 'actual_over_total', ...usage },
    });
  }

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
    await escalate(`suspicious message; flags: ${flags.join(', ') || 'none'}`);
  }
  await call('triage_log_decision', {
    ...target,
    decision: `${verdict.category}/${verdict.urgency}`,
    rationale: verdict.rationale,
  });
  await call('email_apply_label', { ...target, label: verdict.category });

  return { providerMessageId, verdict, ...(actionErrors.length ? { actionErrors } : {}) };
}
