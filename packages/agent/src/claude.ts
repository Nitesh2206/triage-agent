import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ClassifyOutcome, DraftOutcome, LLMProvider } from '@triage/core';
import { VerdictSchema } from './schema.js';

export const CLAUDE_MODEL = 'claude-haiku-4-5';
/** Drafting runs the stronger model — only invoked when a draft is permitted. */
export const CLAUDE_DRAFT_MODEL = 'claude-sonnet-5';
/** USD per million tokens, per model. */
const PRICE: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 3, output: 15 },
};

function usd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICE[model] ?? { input: 0, output: 0 };
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Minimal client shape so unit tests can inject a stub (same idiom as SupabaseStore). */
export interface ClaudeClient {
  messages: {
    parse(params: unknown): Promise<{
      parsed_output: unknown;
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>;
    create(params: unknown): Promise<{
      content: { type: string; text?: string }[];
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
    private readonly draftModel: string = CLAUDE_DRAFT_MODEL,
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
        usd: usd(this.model, input_tokens, output_tokens),
      },
    };
  }

  async draftReply(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
  }): Promise<DraftOutcome> {
    const response = await this.client.messages.create({
      model: this.draftModel,
      max_tokens: input.maxOutputTokens,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
    });
    if (response.stop_reason !== 'end_turn') {
      throw new Error(`claude draft stopped early: ${response.stop_reason}`);
    }
    const body = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (!body) throw new Error('claude draft returned no text');
    const { input_tokens, output_tokens } = response.usage;
    return {
      body,
      usage: {
        model: this.draftModel,
        inputTokens: input_tokens,
        outputTokens: output_tokens,
        usd: usd(this.draftModel, input_tokens, output_tokens),
      },
    };
  }
}
