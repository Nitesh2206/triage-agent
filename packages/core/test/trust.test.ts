import { describe, it, expect } from 'vitest';
import { resolveTrustTier, type TrustConfig, type TriageMessage } from '../src/index.js';

const config: TrustConfig = {
  internalDomains: ['brightpath.edu.au'],
  knownDomains: ['safetygearco.com.au'],
};

function msg(from: string, authenticity?: TriageMessage['authenticity']): TriageMessage {
  return {
    provider: 'fixture',
    providerMessageId: 'x',
    from: { address: from, displayName: 'BrightPath Admin' }, // hostile display name everywhere
    to: [],
    subject: 's',
    receivedAt: '2026-08-01T00:00:00Z',
    body: 'b',
    authenticity,
  };
}

describe('resolveTrustTier', () => {
  it('internal domain with aligned pass → tier 2', () => {
    expect(
      resolveTrustTier(
        msg('p@brightpath.edu.au', { dmarc: 'pass', alignedDomain: 'brightpath.edu.au' }),
        config,
      ),
    ).toBe(2);
  });

  it('known domain with aligned pass → tier 1', () => {
    expect(
      resolveTrustTier(
        msg('a@safetygearco.com.au', { dmarc: 'pass', alignedDomain: 'safetygearco.com.au' }),
        config,
      ),
    ).toBe(1);
  });

  it('unknown domain, even with aligned pass → tier 0', () => {
    expect(
      resolveTrustTier(msg('a@gmail.com', { dmarc: 'pass', alignedDomain: 'gmail.com' }), config),
    ).toBe(0);
  });

  it('internal domain with dmarc fail → tier 0 (fail closed)', () => {
    expect(
      resolveTrustTier(
        msg('p@brightpath.edu.au', { dmarc: 'fail', alignedDomain: 'brightpath.edu.au' }),
        config,
      ),
    ).toBe(0);
  });

  it('missing authenticity evidence → tier 0 (fail closed)', () => {
    expect(resolveTrustTier(msg('p@brightpath.edu.au'), config)).toBe(0);
  });

  it('aligned-domain mismatch → tier 0 (fail closed)', () => {
    expect(
      resolveTrustTier(
        msg('p@brightpath.edu.au', { dmarc: 'pass', alignedDomain: 'evil.example.com' }),
        config,
      ),
    ).toBe(0);
  });

  it('multi-@ address is malformed → tier 0, never parsed to an inner domain', () => {
    expect(
      resolveTrustTier(
        msg('x@brightpath.edu.au@evil.com', { dmarc: 'pass', alignedDomain: 'brightpath.edu.au' }),
        config,
      ),
    ).toBe(0);
  });

  it('display-name spoof gains nothing: tier comes from the address domain only', () => {
    // displayName is "BrightPath Admin" in every message above; a gmail sender stays tier 0.
    expect(
      resolveTrustTier(
        msg('evil@gmail.com', { dmarc: 'pass', alignedDomain: 'gmail.com' }),
        config,
      ),
    ).toBe(0);
  });
});
