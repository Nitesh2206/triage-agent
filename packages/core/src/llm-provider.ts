import type { Category, Urgency } from './types.js';

/** Signals of manipulation inside the message body. Any true flag forces category 'suspicious' in code. */
export interface SuspicionFlags {
  /** Body attempts to direct the agent ("ignore previous instructions", fake system notices). */
  instructionOverride: boolean;
  /** Asks for forwarding, data dumps, credentials, or contact outside the thread. */
  exfiltrationAttempt: boolean;
  /** Claims an identity or authority the envelope does not support. */
  impersonation: boolean;
  /** Encoded or hidden content: base64 blobs, HTML comments, zero-width text. */
  hiddenOrEncodedContent: boolean;
}

export interface ClassificationVerdict {
  category: Category;
  urgency: Urgency;
  suspicion: SuspicionFlags;
  /** One sentence. Passed to triage_log_decision; audit stores its length only. */
  rationale: string;
}

export interface LLMUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface ClassifyOutcome {
  verdict: ClassificationVerdict;
  usage: LLMUsage;
}

export interface DraftOutcome {
  /** Reply body text. Staged via email_draft_reply — never sent by the agent. */
  body: string;
  usage: LLMUsage;
}

/**
 * Classification pass: structured output only, ZERO tool access.
 * Implementations must validate the model's JSON and throw on any deviation —
 * callers fail closed (escalate to a human).
 *
 * Draft pass: plain text reply body, still zero tool access — code stages the
 * draft through the guarded MCP tool. Implementations throw on truncation or
 * empty output; callers surface the failure without aborting triage.
 */
export interface LLMProvider {
  readonly name: string;
  classify(input: { system: string; user: string; maxOutputTokens: number }): Promise<ClassifyOutcome>;
  draftReply(input: { system: string; user: string; maxOutputTokens: number }): Promise<DraftOutcome>;
}
