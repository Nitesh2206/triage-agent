import { describe, expect, it } from 'vitest';
import { CursorExpiredError } from '@triage/core';
import {
  GmailProvider,
  mapGmailMessage,
  withRetry,
  type GmailApi,
  type GmailMessage,
} from '../src/gmail-provider.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function fullMessage(id: string, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: '1755600000000',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: '"Ada Lovelace" <ada@example.com>' },
        { name: 'To', value: 'ops@school.example, second@school.example' },
        { name: 'Cc', value: 'cc@example.com' },
        { name: 'Subject', value: 'Enrolment question' },
        { name: 'In-Reply-To', value: '<prev@example.com>' },
        { name: 'References', value: '<a@x> <b@y>' },
        {
          name: 'Authentication-Results',
          value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass (p=NONE) header.from=example.com',
        },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain body') } },
        { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
      ],
    },
    ...overrides,
  };
}

function stubGmail(opts: {
  historyPages?: {
    history?: { messagesAdded?: { message?: { id?: string } }[] }[];
    historyId?: string;
    nextPageToken?: string;
  }[];
  historyError?: unknown;
  listPages?: { messages?: { id?: string }[]; nextPageToken?: string }[];
  profileHistoryId?: string;
  messages?: Record<string, GmailMessage>;
}): GmailApi & { historyParams: unknown[] } {
  let historyCall = 0;
  let listCall = 0;
  const historyParams: unknown[] = [];
  return {
    historyParams,
    users: {
      getProfile: async () => ({ data: { historyId: opts.profileHistoryId ?? '9999' } }),
      history: {
        list: async (params: unknown) => {
          historyParams.push(params);
          if (opts.historyError) throw opts.historyError;
          return { data: opts.historyPages![historyCall++]! };
        },
      },
      messages: {
        list: async () => ({ data: opts.listPages![listCall++]! }),
        get: async ({ id }) => ({ data: opts.messages![id]! }),
      },
    },
  };
}

describe('mapGmailMessage', () => {
  it('maps headers, body, and authentication evidence', () => {
    const m = mapGmailMessage(fullMessage('m1'));
    expect(m.provider).toBe('gmail');
    expect(m.providerMessageId).toBe('m1');
    expect(m.providerThreadId).toBe('thread-m1');
    expect(m.from).toEqual({ address: 'ada@example.com', displayName: 'Ada Lovelace' });
    expect(m.to.map((t) => t.address)).toEqual(['ops@school.example', 'second@school.example']);
    expect(m.cc?.[0]?.address).toBe('cc@example.com');
    expect(m.inReplyTo).toBe('<prev@example.com>');
    expect(m.headerReferences).toEqual(['<a@x>', '<b@y>']);
    expect(m.subject).toBe('Enrolment question');
    expect(m.receivedAt).toBe(new Date(1755600000000).toISOString());
    expect(m.body).toBe('plain body');
    expect(m.authenticity).toEqual({ dmarc: 'pass', alignedDomain: 'example.com' });
  });

  it('falls back to stripped HTML when no text/plain part exists', () => {
    const msg = fullMessage('m2');
    msg.payload!.parts = [{ mimeType: 'text/html', body: { data: b64('<b>hi</b> there') } }];
    expect(mapGmailMessage(msg).body).toBe('hi there');
  });

  it('missing Authentication-Results -> authenticity undefined (tier 0 downstream)', () => {
    const msg = fullMessage('m3');
    msg.payload!.headers = msg.payload!.headers!.filter((h) => h.name !== 'Authentication-Results');
    expect(mapGmailMessage(msg).authenticity).toBeUndefined();
  });
});

describe('GmailProvider.sync', () => {
  it('incremental: pages through history, dedupes ids, advances cursor', async () => {
    const gmail = stubGmail({
      historyPages: [
        {
          history: [{ messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] }],
          nextPageToken: 'p2',
          historyId: '1500',
        },
        { history: [{ messagesAdded: [{ message: { id: 'b' } }] }], historyId: '1600' },
      ],
      messages: { a: fullMessage('a'), b: fullMessage('b') },
    });
    const { messages, nextCursor } = await new GmailProvider(gmail).sync('1000');
    expect(messages.map((m) => m.providerMessageId).sort()).toEqual(['a', 'b']);
    expect(nextCursor).toBe('1600');
    // INBOX only — otherwise the agent's own sent replies get re-ingested.
    expect(gmail.historyParams[0]).toMatchObject({ labelId: 'INBOX' });
  });

  it('expired historyId (404) -> CursorExpiredError', async () => {
    const gmail = stubGmail({ historyError: { response: { status: 404 } } });
    await expect(new GmailProvider(gmail).sync('old')).rejects.toThrow(CursorExpiredError);
  });

  it('full sync: bounded inbox query, cursor from profile historyId', async () => {
    const gmail = stubGmail({
      listPages: [{ messages: [{ id: 'a' }], nextPageToken: 'p2' }, { messages: [{ id: 'b' }] }],
      profileHistoryId: '4242',
      messages: { a: fullMessage('a'), b: fullMessage('b') },
    });
    const { messages, nextCursor } = await new GmailProvider(gmail).sync();
    expect(messages).toHaveLength(2);
    expect(nextCursor).toBe('4242');
  });
});

describe('withRetry', () => {
  it('retries 429/5xx then succeeds; never retries 4xx', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw { response: { status: calls === 1 ? 429 : 503 } };
      return 'ok';
    };
    await expect(withRetry(flaky, async () => {})).resolves.toBe('ok');
    expect(calls).toBe(3);

    const denied = async () => {
      throw { response: { status: 403 } };
    };
    await expect(withRetry(denied, async () => {})).rejects.toEqual({ response: { status: 403 } });
  });

  it('gives up after 3 attempts', async () => {
    let calls = 0;
    const down = async () => {
      calls++;
      throw { response: { status: 500 } };
    };
    await expect(withRetry(down, async () => {})).rejects.toEqual({ response: { status: 500 } });
    expect(calls).toBe(3);
  });
});
