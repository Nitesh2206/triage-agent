import { GoogleGenAI } from '@google/genai';
import type { ClassifyOutcome, DraftOutcome, LLMProvider } from '@triage/core';
import { VERDICT_JSON_SCHEMA, VerdictSchema } from './schema.js';

// 2.5-generation models are retired for new accounts (404); 3.5-flash accepts
// thinkingBudget 0, 3.5-flash-lite does not.
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

/** Minimal client shape so unit tests can inject a stub. */
export interface GeminiClient {
  models: {
    generateContent(params: unknown): Promise<{
      text?: string;
      candidates?: { finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>;
  };
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  constructor(
    private readonly client: GeminiClient,
    private readonly model: string = GEMINI_DEFAULT_MODEL,
  ) {}

  static fromApiKey(apiKey: string, model?: string): GeminiProvider {
    return new GeminiProvider(new GoogleGenAI({ apiKey }) as unknown as GeminiClient, model);
  }

  async classify(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
  }): Promise<ClassifyOutcome> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: input.user,
      config: {
        systemInstruction: input.system,
        maxOutputTokens: input.maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: VERDICT_JSON_SCHEMA,
        // 2.5-flash thinks by default and thinking tokens count against
        // maxOutputTokens (512) — complex inputs hit MAX_TOKENS with no text.
        // ponytail: assumes a 2.5-flash-class model; GEMINI_MODEL overrides that
        // can't disable thinking (2.5-pro) will error loudly here.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP') {
      throw new Error(`gemini classify stopped early: ${finish}`);
    }
    if (!response.text) throw new Error('gemini classify returned no text');
    // Zod is the authority — the API schema is steering, not a guarantee.
    const verdict = VerdictSchema.parse(JSON.parse(response.text));
    return {
      verdict,
      usage: {
        model: this.model,
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        usd: 0, // free tier
      },
    };
  }

  async draftReply(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
  }): Promise<DraftOutcome> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: input.user,
      config: {
        systemInstruction: input.system,
        maxOutputTokens: input.maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP') {
      throw new Error(`gemini draft stopped early: ${finish}`);
    }
    const body = response.text?.trim();
    if (!body) throw new Error('gemini draft returned no text');
    return {
      body,
      usage: {
        model: this.model,
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        usd: 0, // free tier
      },
    };
  }
}
