import type { TriageMessage, TrustTier } from './types.js';

export interface TrustConfig {
  internalDomains: string[];
  knownDomains: string[];
}

/**
 * Pure trust-tier resolution. Fail closed: any missing, failing, or misaligned
 * authentication evidence yields tier 0 regardless of domain. Display names are
 * never consulted — only the verified from-address domain.
 */
export function resolveTrustTier(message: TriageMessage, config: TrustConfig): TrustTier {
  const domain = message.from.address.split('@')[1]?.toLowerCase();
  if (!domain) return 0;

  const auth = message.authenticity;
  if (!auth || auth.dmarc !== 'pass') return 0;
  if (!auth.alignedDomain || auth.alignedDomain.toLowerCase() !== domain) return 0;

  if (config.internalDomains.includes(domain)) return 2;
  if (config.knownDomains.includes(domain)) return 1;
  return 0;
}
