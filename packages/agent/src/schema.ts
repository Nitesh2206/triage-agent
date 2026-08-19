import { z } from 'zod';

export const CATEGORIES = [
  'enrolment_query',
  'certificate_request',
  'complaint',
  'invoice',
  'regulator',
  'spam',
  'suspicious',
  'other',
] as const;

export const URGENCIES = ['low', 'normal', 'high'] as const;

const FLAGS = [
  'instructionOverride',
  'exfiltrationAttempt',
  'impersonation',
  'hiddenOrEncodedContent',
] as const;

export const VerdictSchema = z
  .object({
    category: z.enum(CATEGORIES),
    urgency: z.enum(URGENCIES),
    suspicion: z
      .object({
        instructionOverride: z.boolean(),
        exfiltrationAttempt: z.boolean(),
        impersonation: z.boolean(),
        hiddenOrEncodedContent: z.boolean(),
      })
      .strict(),
    rationale: z.string().max(300),
  })
  .strict();

/** Hand-written JSON schema for Gemini's responseJsonSchema — kept in sync with VerdictSchema by test. */
export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...CATEGORIES] },
    urgency: { type: 'string', enum: [...URGENCIES] },
    suspicion: {
      type: 'object',
      properties: Object.fromEntries(FLAGS.map((f) => [f, { type: 'boolean' }])),
      required: [...FLAGS],
    },
    rationale: { type: 'string', maxLength: 300 },
  },
  required: ['category', 'urgency', 'suspicion', 'rationale'],
} as const;
