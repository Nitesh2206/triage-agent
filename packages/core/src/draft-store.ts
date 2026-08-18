/** Staging area for reply drafts. Nothing here is ever sent without human approval (phase 4). */
export interface DraftStore {
  createDraft(draft: {
    provider: string;
    providerMessageId: string;
    body: string;
  }): Promise<{ draftId: string }>;
  count(): Promise<number>;
}
