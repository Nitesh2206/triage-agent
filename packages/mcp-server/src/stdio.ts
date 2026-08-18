#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryAuditLog, MemoryDraftStore, MemoryStore } from '@triage/store';
import { FixtureProvider, ingest } from '@triage/ingestor';
import { createServer } from './server.js';
import { trustConfig } from './config.js';

// Standalone stdio server preloaded with fixtures — for MCP inspector / local clients.
const messages = new MemoryStore();
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/fixtures');
await ingest(new FixtureProvider(fixtureDir), messages);

const server = createServer({
  messages,
  audit: new MemoryAuditLog(),
  drafts: new MemoryDraftStore(),
  trust: trustConfig,
});
await server.connect(new StdioServerTransport());
