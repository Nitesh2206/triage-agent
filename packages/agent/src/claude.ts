import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ClassifyOutcome, LLMProvider } from '@triage/core';
import { VerdictSchema } from './schema.js';

export const CLAUDE_MODEL = 'claude-haiku-4-5';
/** USD per million tokens for claude-haiku-4-5. */
const PRICE = { input: 1, output: 5 };

/** Minimal client shape so unit tests can inject a stub (same idiom as SupabaseStore). */
export interface ClaudeClient {
  messages: {
    parse(params: unknown): Promise<{
      parsed_output: unknown;
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude';

  constructor(
    private readonly client: ClaudeClient,
    private readonly model: string = CLAUDE_MODEL,
  ) {}

  static fromApiKey(apiKey: string): ClaudeProvider {
    return new ClaudeProvider(new Anthropic({ apiKey }) as unknown as ClaudeClient);
  }

  async classify(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
  }): Promise<ClassifyOutcome> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: input.maxOutputTokens,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
      output_config: { format: zodOutputFormat(VerdictSchema) },
    });
    if (response.stop_reason !== 'end_turn') {
      throw new Error(`claude classify stopped early: ${response.stop_reason}`);
    }
    // Re-validate: fail closed even if the SDK's parse was lenient.
    const verdict = VerdictSchema.parse(response.parsed_output);
    const { input_tokens, output_tokens } = response.usage;
    return {
      verdict,
      usage: {
        model: this.model,
        inputTokens: input_tokens,
        outputTokens: output_tokens,
        usd: (input_tokens * PRICE.input + output_tokens * PRICE.output) / 1_000_000,
      },
    };
  }
}
