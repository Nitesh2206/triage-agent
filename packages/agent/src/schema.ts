import { z } from 'zod/v4';

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

/** JSON schema for Gemini's responseJsonSchema — generated, cannot drift from VerdictSchema. */
const { $schema: _, ...verdictJsonSchema } = z.toJSONSchema(VerdictSchema);
export const VERDICT_JSON_SCHEMA = verdictJsonSchema;
