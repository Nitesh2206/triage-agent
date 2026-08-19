import type { LLMProvider } from '@triage/core';
import { ClaudeProvider } from './claude.js';
import { FakeLLMProvider } from './fake.js';
import { GeminiProvider } from './gemini.js';

/**
 * Provider from env. LLM_PROVIDER=claude|gemini|fake; default gemini when
 * GEMINI_API_KEY is set, else fake (credential-free demo).
 */
export function createProvider(env: Record<string, string | undefined> = process.env): LLMProvider {
  const choice = env.LLM_PROVIDER ?? (env.GEMINI_API_KEY ? 'gemini' : 'fake');
  switch (choice) {
    case 'claude':
      if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=claude requires ANTHROPIC_API_KEY');
      return ClaudeProvider.fromApiKey(env.ANTHROPIC_API_KEY);
    case 'gemini':
      if (!env.GEMINI_API_KEY) throw new Error('LLM_PROVIDER=gemini requires GEMINI_API_KEY');
      return GeminiProvider.fromApiKey(env.GEMINI_API_KEY, env.GEMINI_MODEL);
    case 'fake':
      return new FakeLLMProvider();
    default:
      throw new Error(`unknown LLM_PROVIDER: ${choice}`);
  }
}
