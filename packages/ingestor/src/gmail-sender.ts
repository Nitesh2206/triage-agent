import type { MailSender } from '@triage/core';
import { withRetry } from './gmail-provider.js';
import { gmailClient, hasGmailEnv } from './gmail-auth.js';

/** Structural slice of the Gmail API the sender uses — injectable for tests. */
export interface GmailSendApi {
  users: {
    threads: {
      get(params: {
        userId: string;
        id: string;
        format: string;
        metadataHeaders?: string[];
      }): Promise<{
        data: {
          messages?:
            | {
                payload?: {
                  headers?: { name?: string | null; value?: string | null }[] | null;
                } | null;
              }[]
            | null;
        };
      }>;
    };
    messages: {
      send(params: {
        userId: string;
        requestBody: { raw: string; threadId?: string };
      }): Promise<{ data: { id?: string | null } }>;
      list(params: { userId: string; q: string }): Promise<{
        data: { messages?: { id?: string | null }[] | null };
      }>;
    };
  };
}

/**
 * Real Gmail send. We author the raw RFC 5322 message, so the Message-ID on
 * the wire is exactly the persisted send id — that makes findSent() a reliable
 * recovery probe (modulo Gmail search lag; processApprovals holds a window).
 * In-Reply-To/References are resolved from the source thread's last message,
 * per the stored providerThreadId — never from model output.
 */
export class GmailSender implements MailSender {
  constructor(private readonly gmail: GmailSendApi) {}

  async send(mail: {
    to: string;
    subject: string;
    body: string;
    messageId: string;
    providerThreadId?: string;
  }): Promise<{ providerSendId?: string }> {
    let inReplyTo: string | undefined;
    if (mail.providerThreadId) {
      const { data } = await withRetry(() =>
        this.gmail.users.threads.get({
          userId: 'me',
          id: mail.providerThreadId!,
          format: 'metadata',
          metadataHeaders: ['Message-ID'],
        }),
      );
      const last = data.messages?.[data.messages.length - 1];
      inReplyTo =
        last?.payload?.headers?.find((h) => h.name?.toLowerCase() === 'message-id')?.value ??
        undefined;
    }

    const lines = [
      `To: ${mail.to}`,
      `Subject: ${encodeHeader(mail.subject)}`,
      `Message-ID: ${mail.messageId}`,
      ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(mail.body, 'utf8').toString('base64'),
    ];
    const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');

    const { data } = await withRetry(() =>
      this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId: mail.providerThreadId },
      }),
    );
    return { providerSendId: data.id ?? undefined };
  }

  /** Recovery probe: eventually consistent — a miss right after a send is possible. */
  async findSent(messageId: string): Promise<boolean> {
    const { data } = await withRetry(() =>
      this.gmail.users.messages.list({ userId: 'me', q: `rfc822msgid:${messageId}` }),
    );
    return (data.messages ?? []).length > 0;
  }
}

/** RFC 2047 encode a header when it contains non-ASCII; pass ASCII through. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Gmail env present -> real sender; otherwise the simulated logger (fail-closed
 * default: nothing real leaves without deliberate credentials).
 */
export function createSender(): MailSender {
  if (hasGmailEnv()) return new GmailSender(gmailClient() as unknown as GmailSendApi);
  return {
    async send(mail) {
      console.log(`[simulated send] to=${mail.to} subject=${JSON.stringify(mail.subject)}`);
      return {};
    },
  };
}
