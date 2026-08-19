import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuditLog, DraftStore, MessageStore, TrustConfig } from '@triage/core';
import { guarded } from './guard.js';

export interface ServerDeps {
  messages: MessageStore;
  audit: AuditLog;
  drafts: DraftStore;
  trust: TrustConfig;
}

const target = {
  provider: z.string().describe('Mail provider the message came from (e.g. fixture, gmail)'),
  providerMessageId: z.string().describe('Provider message id — unique only per provider'),
};

/** All triage tools, wrapped in the fail-closed guard. Phase 2: effects are records, not sends. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'triage-tools', version: '0.1.0' });
  const guard = { messages: deps.messages, audit: deps.audit, trust: deps.trust };

  server.registerTool(
    'email_apply_label',
    {
      description: 'Apply a triage label to a message',
      inputSchema: { ...target, label: z.string() },
    },
    (args) => guarded(guard, 'email_apply_label', args, { label: args.label }, async () => ({
      applied: args.label,
    })),
  );

  server.registerTool(
    'email_draft_reply',
    {
      description:
        'Store a draft reply for human approval. Never sends. Requires an internal/allowlisted sender.',
      inputSchema: { ...target, body: z.string() },
    },
    (args) =>
      guarded(guard, 'email_draft_reply', args, { bodyLength: args.body.length }, async () => {
        const { draftId } = await deps.drafts.createDraft({
          provider: args.provider,
          providerMessageId: args.providerMessageId,
          body: args.body,
        });
        return { draftId };
      }),
  );

  server.registerTool(
    'trello_create_card',
    {
      description: 'Queue a follow-up task card for this message',
      inputSchema: { ...target, title: z.string(), description: z.string().optional() },
    },
    (args) =>
      guarded(
        guard,
        'trello_create_card',
        args,
        { titleLength: args.title.length, hasDescription: args.description !== undefined },
        async () => ({ cardQueued: true }),
      ),
  );

  server.registerTool(
    'triage_escalate',
    {
      description: 'Escalate a message to a human with a reason',
      // flags: suspicion flag NAMES only (enum-like identifiers, never message content),
      // so the audit row shows humans WHY without leaking body text.
      inputSchema: { ...target, reason: z.string(), flags: z.array(z.string()).optional() },
    },
    (args) =>
      guarded(
        guard,
        'triage_escalate',
        args,
        { reasonLength: args.reason.length, ...(args.flags ? { flags: args.flags } : {}) },
        async () => ({ escalated: true }),
      ),
  );

  server.registerTool(
    'triage_log_decision',
    {
      description: 'Record a triage decision (e.g. classification) for a message',
      inputSchema: { ...target, decision: z.string(), rationale: z.string().optional() },
    },
    (args) =>
      guarded(
        guard,
        'triage_log_decision',
        args,
        { decision: args.decision, rationaleLength: args.rationale?.length ?? 0 },
        async () => ({ logged: true }),
      ),
  );

  return server;
}
