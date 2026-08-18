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
  /** Provider's thread/conversation id. Required to enforce source-thread-only drafting. */
  providerThreadId?: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  /** RFC 5322 In-Reply-To / References message-ids, for thread provenance. */
  inReplyTo?: string;
  headerReferences?: string[];
  subject: string;
  receivedAt: string; // ISO 8601
  body: string;
  /** Raw auth results (SPF/DKIM) when the provider exposes them. Trust tiers derive from these, never from displayName. */
  authResults?: string;
}
