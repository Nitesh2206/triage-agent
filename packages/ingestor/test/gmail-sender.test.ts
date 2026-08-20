import { describe, expect, it } from 'vitest';
import { GmailSender, type GmailSendApi } from '../src/gmail-sender.js';

function stub(threadMessageIds: string[], listHits = 0) {
  const sent: { raw: string; threadId?: string }[] = [];
  const api: GmailSendApi = {
    users: {
      threads: {
        get: async () => ({
          data: {
            messages: threadMessageIds.map((id) => ({
              payload: { headers: [{ name: 'Message-ID', value: id }] },
            })),
          },
        }),
      },
      messages: {
        send: async ({ requestBody }) => {
          sent.push(requestBody);
          return { data: { id: 'gmail-123' } };
        },
        list: async () => ({
          data: { messages: Array.from({ length: listHits }, (_, i) => ({ id: `m${i}` })) },
        }),
      },
    },
  };
  return { api, sent };
}

describe('GmailSender', () => {
  it('threads the reply: In-Reply-To from the LAST thread message, our Message-ID on the wire', async () => {
    const { api, sent } = stub(['<first@x>', '<last@x>']);
    const result = await new GmailSender(api).send({
      to: 'sarah@example.com',
      subject: 'Re: Enrolment',
      body: 'Hello',
      messageId: '<draft-1-abc@triage>',
      providerThreadId: 'thread-9',
    });
    expect(result.providerSendId).toBe('gmail-123');
    expect(sent[0]!.threadId).toBe('thread-9');
    const mime = Buffer.from(sent[0]!.raw, 'base64url').toString('utf8');
    expect(mime).toContain('Message-ID: <draft-1-abc@triage>');
    expect(mime).toContain('In-Reply-To: <last@x>');
    expect(mime).toContain('To: sarah@example.com');
    expect(Buffer.from(mime.split('\r\n\r\n')[1]!, 'base64').toString('utf8')).toBe('Hello');
  });

  it('no thread id: sends without threading headers', async () => {
    const { api, sent } = stub([]);
    await new GmailSender(api).send({
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      messageId: '<m@triage>',
    });
    const mime = Buffer.from(sent[0]!.raw, 'base64url').toString('utf8');
    expect(mime).not.toContain('In-Reply-To');
  });

  it('findSent maps search hits to a boolean', async () => {
    expect(await new GmailSender(stub([], 1).api).findSent('<m@triage>')).toBe(true);
    expect(await new GmailSender(stub([], 0).api).findSent('<m@triage>')).toBe(false);
  });
});
