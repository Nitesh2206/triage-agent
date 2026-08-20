import type {
  Category,
  ClassifyOutcome,
  DraftOutcome,
  LLMProvider,
  SuspicionFlags,
  Urgency,
} from '@triage/core';

// Ordered: first matching rule wins. Suspicion keywords checked separately.
const CATEGORY_KEYWORDS: [Category, RegExp][] = [
  ['invoice', /\binvoice|payment due|overdue|remittance\b/i],
  ['certificate_request', /\bcertificate|statement of attainment|testamur\b/i],
  ['complaint', /\bcomplaint|unacceptable|disappointed|refund\b/i],
  ['regulator', /\baudit|compliance|regulator|asqa|standard(s)? clause\b/i],
  ['enrolment_query', /\benrol|course|intake|fees|study\b/i],
  ['spam', /\bunsubscribe|special offer|seo|limited time|winner\b/i],
];

function flags(text: string): SuspicionFlags {
  return {
    instructionOverride:
      /ignore (all |previous |prior )*instructions|system (message|prompt|notice)|\b(assistant|ai|model) instruction|elevate .{0,20}trust/i.test(
        text,
      ),
    exfiltrationAttempt:
      /\bforward (all|the)|send .*(list|records|credentials|password)|(full|entire|all) .{0,20}(contact|student) (list|records)|alternate address\b/i.test(
        text,
      ),
    impersonation: /\b(i am|this is) (the )?(administrator|it department|principal|ceo)\b/i.test(
      text,
    ),
    hiddenOrEncodedContent:
      /<!--|[A-Za-z0-9+/]{40,}={0,2}/.test(text) || text.includes('\u200b'),
  };
}

/**
 * Deterministic keyword classifier — powers the credential-free demo and tests.
 * Never sees fixture ground truth (`expected` is stripped before ingest).
 */
// ponytail: crude heuristic by design; real classification quality lives in the LLM providers.
export class FakeLLMProvider implements LLMProvider {
  readonly name = 'fake';

  async classify(input: { system: string; user: string }): Promise<ClassifyOutcome> {
    const text = input.user;
    const suspicion = flags(text);
    const suspicious = Object.values(suspicion).some(Boolean);
    const category: Category = suspicious
      ? 'suspicious'
      : (CATEGORY_KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? 'other');
    const urgency: Urgency =
      suspicious || /\burgent|asap|immediately|overdue\b/i.test(text) ? 'high' : 'normal';
    return {
      verdict: { category, urgency, suspicion, rationale: `keyword match: ${category}` },
      usage: { model: 'fake', inputTokens: 0, outputTokens: 0, usd: 0 },
    };
  }

  async draftReply(input: { user: string }): Promise<DraftOutcome> {
    const subject = /^Subject: (.*)$/m.exec(input.user)?.[1] ?? 'your enquiry';
    const body = [
      'Hi,',
      '',
      `Thanks for getting in touch about "${subject}". The team will review your enquiry and confirm the details with you shortly.`,
      '',
      'Kind regards,',
      'BrightPath Student Services',
    ].join('\n');
    return { body, usage: { model: 'fake', inputTokens: 0, outputTokens: 0, usd: 0 } };
  }
}
