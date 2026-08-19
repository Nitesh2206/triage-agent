/** One model call's spend. Mirrors the costs table (migration 0001). */
export interface CostEntry {
  provider: string;
  providerMessageId: string;
  stage: 'classify' | 'draft' | 'eval';
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface CostLog {
  record(entry: CostEntry): Promise<void>;
  list(): Promise<CostEntry[]>;
}
