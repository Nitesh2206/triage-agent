import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailProvider, TriageMessage } from '@triage/core';

interface Fixture extends TriageMessage {
  /** Ground-truth labels for evals; ignored by the pipeline itself. */
  expected?: { category: string; urgency: string };
}

/** Replays labeled emails from JSON files. Zero credentials, zero network. */
export class FixtureProvider implements MailProvider {
  readonly name = 'fixture';

  constructor(private readonly fixtureDir: string) {}

  async listNewMessages(since?: string): Promise<TriageMessage[]> {
    const files = (await readdir(this.fixtureDir)).filter((f) => f.endsWith('.json'));
    const messages: TriageMessage[] = [];
    for (const file of files) {
      const raw = await readFile(join(this.fixtureDir, file), 'utf8');
      const { expected: _expected, ...message } = JSON.parse(raw) as Fixture;
      if (!since || message.receivedAt > since) messages.push(message);
    }
    return messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
}
