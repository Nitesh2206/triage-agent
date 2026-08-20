import {
  CursorExpiredError,
  parseAuthResults,
  type EmailAddress,
  type MailProvider,
  type SyncResult,
  type TriageMessage,
} from '@triage/core';

/**
 * Structural slice of the Gmail API this provider uses — injectable so tests
 * run against a stub (same pattern as SupabaseStore's injected client).
 * The real client from gmail-auth.ts satisfies it.
 */
export interface GmailApi {
  users: {
    getProfile(params: { userId: string }): Promise<{ data: { historyId?: string | null } }>;
    history: {
      list(params: {
        userId: string;
        startHistoryId: string;
        historyTypes: string[];
        labelId?: string;
        pageToken?: string;
      }): Promise<{
        data: {
          history?: { messagesAdded?: { message?: { id?: string | null } }[] }[] | null;
          historyId?: string | null;
          nextPageToken?: string | null;
        };
      }>;
    };
    messages: {
      list(params: { userId: string; q: string; pageToken?: string }): Promise<{
        data: { messages?: { id?: string | null }[] | null; nextPageToken?: string | null };
      }>;
      get(params: { userId: string; id: string; format: string }): Promise<{ data: GmailMessage }>;
    };
  };
}

export interface GmailMessage {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  payload?: GmailPart | null;
}

interface GmailPart {
  mimeType?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

/**
 * Live Gmail ingest. Cursor = historyId. Gmail answers 404 when a historyId
 * has aged out — mapped to CursorExpiredError so the caller full-resyncs.
 * First run (no cursor) is bounded to a recent window so connecting an old
 * mailbox does not ingest years of mail.
 */
export class GmailProvider implements MailProvider {
  readonly name = 'gmail';

  constructor(
    private readonly gmail: GmailApi,
    private readonly fullSyncWindow = 'newer_than:30d',
  ) {}

  async sync(cursor?: string): Promise<SyncResult> {
    const { ids, nextCursor } = cursor ? await this.listSince(cursor) : await this.listRecent();
    const messages: TriageMessage[] = [];
    for (const id of ids) {
      const { data } = await withRetry(() =>
        this.gmail.users.messages.get({ userId: 'me', id, format: 'full' }),
      );
      messages.push(mapGmailMessage(data));
    }
    messages.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    return { messages, nextCursor };
  }

  private async listSince(cursor: string): Promise<{ ids: string[]; nextCursor: string | null }> {
    const ids = new Set<string>();
    let nextCursor = cursor;
    let pageToken: string | undefined;
    try {
      do {
        const { data } = await withRetry(() =>
          this.gmail.users.history.list({
            userId: 'me',
            startHistoryId: cursor,
            historyTypes: ['messageAdded'],
            // INBOX only: without this, the agent's own sent replies appear as
            // messageAdded and the next tick would ingest and triage them.
            labelId: 'INBOX',
            pageToken,
          }),
        );
        for (const h of data.history ?? []) {
          for (const added of h.messagesAdded ?? []) {
            if (added.message?.id) ids.add(added.message.id);
          }
        }
        if (data.historyId) nextCursor = String(data.historyId);
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (e) {
      if (statusOf(e) === 404) throw new CursorExpiredError(this.name);
      throw e;
    }
    return { ids: [...ids], nextCursor };
  }

  private async listRecent(): Promise<{ ids: string[]; nextCursor: string | null }> {
    const profile = await withRetry(() => this.gmail.users.getProfile({ userId: 'me' }));
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await withRetry(() =>
        this.gmail.users.messages.list({
          userId: 'me',
          q: `in:inbox ${this.fullSyncWindow}`,
          pageToken,
        }),
      );
      for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return { ids, nextCursor: profile.data.historyId ? String(profile.data.historyId) : null };
  }
}

export function mapGmailMessage(data: GmailMessage): TriageMessage {
  if (!data.id) throw new Error('gmail message without id');
  const header = headerReader(data.payload);
  const authResultsRaw = header('authentication-results');
  const references = header('references');
  return {
    provider: 'gmail',
    providerMessageId: data.id,
    providerThreadId: data.threadId ?? undefined,
    from: parseAddress(header('from') ?? ''),
    to: parseAddressList(header('to')),
    cc: parseAddressList(header('cc')),
    inReplyTo: header('in-reply-to') ?? undefined,
    headerReferences: references ? references.split(/\s+/).filter(Boolean) : [],
    subject: header('subject') ?? '(no subject)',
    receivedAt: data.internalDate
      ? new Date(Number(data.internalDate)).toISOString()
      : new Date(Date.parse(header('date') ?? '') || Date.now()).toISOString(),
    body: extractBody(data.payload),
    // Fail closed: no parsable Authentication-Results -> undefined -> tier 0.
    authenticity: parseAuthResults(authResultsRaw),
    authResultsRaw: authResultsRaw ?? undefined,
  };
}

function headerReader(payload?: GmailPart | null): (name: string) => string | undefined {
  const headers = payload?.headers ?? [];
  return (name) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function parseAddress(raw: string): EmailAddress {
  const match = /^(.*)<([^>]+)>\s*$/.exec(raw.trim());
  if (match) {
    const displayName = match[1]!.trim().replace(/^"|"$/g, '').trim();
    return { address: match[2]!.trim(), displayName: displayName || undefined };
  }
  return { address: raw.trim() };
}

// ponytail: naive comma split — a quoted display name containing a comma
// splits wrong. Fine for a triage inbox; swap in a real RFC 5322 parser if
// mangled To/Cc lists ever matter (from-address uses parseAddress directly).
function parseAddressList(raw?: string): EmailAddress[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => parseAddress(part))
    .filter((a) => a.address.length > 0);
}

/** Prefer text/plain; fall back to tag-stripped HTML. Depth-first over parts. */
function extractBody(payload?: GmailPart | null): string {
  const plain = findPart(payload, 'text/plain');
  if (plain) return decode(plain);
  const html = findPart(payload, 'text/html');
  if (html)
    return decode(html)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return '';
}

function findPart(part: GmailPart | null | undefined, mimeType: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decode(base64url: string): string {
  return Buffer.from(base64url, 'base64url').toString('utf8');
}

function statusOf(e: unknown): number | undefined {
  const err = e as { status?: number; code?: number; response?: { status?: number } };
  return (
    err.response?.status ?? err.status ?? (typeof err.code === 'number' ? err.code : undefined)
  );
}

/** Jittered exponential retry for transient Gmail errors (429/5xx), 3 attempts. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = statusOf(e);
      const transient = status === 429 || (status !== undefined && status >= 500);
      if (!transient) throw e;
      lastError = e;
      if (attempt < 2) await sleep(1000 * 2 ** attempt * (0.5 + Math.random()));
    }
  }
  throw lastError;
}
