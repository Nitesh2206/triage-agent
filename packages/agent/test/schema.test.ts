import { describe, expect, it } from 'vitest';
import { CATEGORIES, URGENCIES, VERDICT_JSON_SCHEMA, VerdictSchema } from '../src/schema.js';

const valid = {
  category: 'complaint',
  urgency: 'high',
  suspicion: {
    instructionOverride: false,
    exfiltrationAttempt: false,
    impersonation: false,
    hiddenOrEncodedContent: false,
  },
  rationale: 'Customer unhappy with course delivery.',
};

describe('VerdictSchema', () => {
  it('parses a valid verdict', () => {
    expect(VerdictSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unknown category', () => {
    expect(() => VerdictSchema.parse({ ...valid, category: 'phishing' })).toThrow();
  });

  it('rejects extra keys (schema drift)', () => {
    expect(() => VerdictSchema.parse({ ...valid, tool: 'email_draft_reply' })).toThrow();
    expect(() =>
      VerdictSchema.parse({ ...valid, suspicion: { ...valid.suspicion, extra: true } }),
    ).toThrow();
  });

  it('rejects missing suspicion flag', () => {
    const { instructionOverride: _x, ...rest } = valid.suspicion;
    expect(() => VerdictSchema.parse({ ...valid, suspicion: rest })).toThrow();
  });

  it('JSON schema enums match zod enums (single source of truth)', () => {
    expect(VERDICT_JSON_SCHEMA.properties.category.enum).toEqual([...CATEGORIES]);
    expect(VERDICT_JSON_SCHEMA.properties.urgency.enum).toEqual([...URGENCIES]);
    expect(Object.keys(VERDICT_JSON_SCHEMA.properties.suspicion.properties)).toEqual(
      Object.keys(valid.suspicion),
    );
  });
});
