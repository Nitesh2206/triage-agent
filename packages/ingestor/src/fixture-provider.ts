import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailProvider, SyncResult, TriageMessage } from '@triage/core';

interface Fixture extends TriageMessage {
  /** Ground-truth labels for evals; ignored by the pipeline itself. */
  expected?: { category: string; urgency: string };
}

/**
 * Replays labeled emails from JSON files. Zero credentials, zero network.
 * Cursor = ISO receivedAt of the latest message already delivered.
 */
export class FixtureProvider implements MailProvider {
  readonly name = 'fixture';

  constructor(private readonly fixtureDir: string) {}

  async sync(cursor?: string): Promise<SyncResult> {
    const files = (await readdir(this.fixtureDir)).filter((f) => f.endsWith('.json'));
    const cursorEpoch = cursor ? Date.parse(cursor) : -Infinity;
    const messages: TriageMessage[] = [];
    for (const file of files) {
      const raw = await readFile(join(this.fixtureDir, file), 'utf8');
      const { expected: _expected, ...message } = JSON.parse(raw) as Fixture;
      if (Date.parse(message.receivedAt) > cursorEpoch) messages.push(message);
    }
    messages.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const last = messages[messages.length - 1];
    return { messages, nextCursor: last ? last.receivedAt : (cursor ?? null) };
  }
}
