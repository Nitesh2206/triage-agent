/** Staging area for reply drafts. Nothing here is ever sent without human approval (phase 4). */

export interface DraftRecord {
  draftId: string;
  provider: string;
  providerMessageId: string;
  body: string;
  createdAt: string; // ISO 8601
}

export interface DraftStore {
  createDraft(draft: {
    provider: string;
    providerMessageId: string;
    body: string;
  }): Promise<{ draftId: string }>;
  getDraft(draftId: string): Promise<DraftRecord | null>;
  listDrafts(): Promise<DraftRecord[]>;
  count(): Promise<number>;
}
