import { randomUUID } from 'node:crypto';
import type { TriageMessage } from '@triage/core';

/**
 * Wraps a message for the classification pass. Envelope facts (provider-verified)
 * sit outside the block; subject and body — both attacker-controlled — sit inside
 * a nonce-delimited block. The random nonce means content inside the block cannot
 * forge the closing delimiter and "escape" into trusted territory.
 */
export function quarantine(message: TriageMessage): string {
  const nonce = randomUUID();
  const auth = message.authenticity;
  return [
    `From address: ${message.from.address}`,
    `DMARC: ${auth ? auth.dmarc : 'none'}${auth?.alignedDomain ? ` (aligned: ${auth.alignedDomain})` : ''}`,
    `Received: ${message.receivedAt}`,
    '',
    `BEGIN UNTRUSTED EMAIL CONTENT ${nonce}`,
    `Subject: ${message.subject}`,
    '',
    message.body,
    `END UNTRUSTED EMAIL CONTENT ${nonce}`,
  ].join('\n');
}
