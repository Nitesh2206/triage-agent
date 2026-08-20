import type { Authenticity } from './types.js';

/**
 * Parse a raw Authentication-Results header into normalized evidence.
 * Fail closed, same semantics as resolveTrustTier: a missing header or a
 * missing dmarc clause yields undefined (=> tier 0); an unrecognized dmarc
 * value is treated as 'fail', never as 'pass'. alignedDomain comes only from
 * the dmarc clause's header.from — never from the display name.
 */
export function parseAuthResults(raw?: string | null): Authenticity | undefined {
  if (!raw) return undefined;
  const dmarcClause = /\bdmarc=([a-z]+)([^;]*)/i.exec(raw);
  if (!dmarcClause) return undefined;
  const value = dmarcClause[1]!.toLowerCase();
  const dmarc = value === 'pass' ? 'pass' : value === 'none' ? 'none' : 'fail';
  const from = /header\.from=([^\s;()]+)/i.exec(dmarcClause[2] ?? '');
  return { dmarc, alignedDomain: from?.[1]?.toLowerCase() };
}
