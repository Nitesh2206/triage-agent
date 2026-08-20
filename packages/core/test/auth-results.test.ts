import { describe, expect, it } from 'vitest';
import { parseAuthResults, resolveTrustTier } from '../src/index.js';
import type { TriageMessage } from '../src/index.js';

const gmailHeader =
  'mx.google.com; dkim=pass header.i=@example.com header.s=sel header.b=abc; ' +
  'spf=pass (google.com: domain of a@example.com designates 1.2.3.4 as permitted sender) ' +
  'smtp.mailfrom=a@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com';

function msg(from: string, raw?: string): TriageMessage {
  return {
    provider: 'gmail',
    providerMessageId: 'x',
    from: { address: from },
    to: [],
    subject: 's',
    receivedAt: new Date().toISOString(),
    body: '',
    authenticity: parseAuthResults(raw),
    authResultsRaw: raw,
  };
}

describe('parseAuthResults (fail closed)', () => {
  it('parses a real Gmail pass header with alignment', () => {
    expect(parseAuthResults(gmailHeader)).toEqual({ dmarc: 'pass', alignedDomain: 'example.com' });
  });

  it('missing header or missing dmarc clause -> undefined', () => {
    expect(parseAuthResults(undefined)).toBeUndefined();
    expect(parseAuthResults('')).toBeUndefined();
    expect(parseAuthResults('mx.google.com; dkim=pass; spf=pass')).toBeUndefined();
  });

  it('fail and none pass through; unknown values map to fail', () => {
    expect(parseAuthResults('h; dmarc=fail header.from=example.com')?.dmarc).toBe('fail');
    expect(parseAuthResults('h; dmarc=none header.from=example.com')?.dmarc).toBe('none');
    expect(parseAuthResults('h; dmarc=temperror header.from=example.com')?.dmarc).toBe('fail');
  });

  it('never invents alignment', () => {
    expect(parseAuthResults('h; dmarc=pass (p=NONE)')).toEqual({
      dmarc: 'pass',
      alignedDomain: undefined,
    });
  });
});

describe('parseAuthResults -> resolveTrustTier end to end', () => {
  const config = { internalDomains: ['internal.example'], knownDomains: ['example.com'] };

  it('aligned pass on a known domain -> tier 1', () => {
    expect(resolveTrustTier(msg('a@example.com', gmailHeader), config)).toBe(1);
  });

  it('missing header -> tier 0 even for an internal address', () => {
    expect(resolveTrustTier(msg('boss@internal.example'), config)).toBe(0);
  });

  it('pass but misaligned domain -> tier 0', () => {
    expect(
      resolveTrustTier(msg('a@internal.example', 'h; dmarc=pass header.from=evil.com'), config),
    ).toBe(0);
  });
});
