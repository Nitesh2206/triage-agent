import type { TrustConfig } from '@triage/core';

/** Checked-in trust configuration for the BrightPath demo environment. */
export const trustConfig: TrustConfig = {
  internalDomains: ['brightpath.edu.au'],
  knownDomains: ['safetygearco.com.au', 'regulator.gov.au', 'regionalcouncil.qld.gov.au'],
};
