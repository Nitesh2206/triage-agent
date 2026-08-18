/** Sender trust tier. Enforced by the MCP server, never by prompts. */
export type TrustTier = 0 | 1 | 2;

export type Category =
  | 'enrolment_query'
  | 'certificate_request'
  | 'complaint'
  | 'invoice'
  | 'regulator'
  | 'spam'
  | 'suspicious'
  | 'other';

export type Urgency = 'low' | 'normal' | 'high';

export interface EmailAddress {
  address: string;
  displayName?: string;
}

/** Normalized email, provider-agnostic. Body is UNTRUSTED content. */
export interface TriageMessage {
  /** Provider's own message id — idempotency key. */
  providerMessageId: string;
  provider: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  receivedAt: string; // ISO 8601
  body: string;
  /** Raw auth results (SPF/DKIM) when the provider exposes them. Trust tiers derive from these, never from displayName. */
  authResults?: string;
}
