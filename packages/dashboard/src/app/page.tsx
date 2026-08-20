import { approve, reject } from './actions';
import { requireOperator } from '../lib/auth';
import { stores } from '../lib/stores';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  // Pages read via the service role, so the operator gate applies here too —
  // middleware only proves a session exists, not that it belongs to an operator.
  await requireOperator();
  const { drafts, approvals, messages } = stores();
  const [draftRows, approvalRows] = await Promise.all([drafts.listDrafts(), approvals.list()]);
  const byDraft = new Map(approvalRows.map((a) => [a.draftId, a]));

  const rows = await Promise.all(
    draftRows.map(async (draft) => ({
      draft,
      approval: byDraft.get(draft.draftId),
      message: await messages.getMessage(draft.provider, draft.providerMessageId),
    })),
  );
  const pending = rows.filter((r) => r.approval?.status === 'pending');
  const decided = rows.filter((r) => r.approval && r.approval.status !== 'pending');

  return (
    <main>
      <h1>Approval queue</h1>
      <p>
        {pending.length} pending · {decided.length} decided
      </p>
      {pending.map(({ draft, message }) => (
        <div className="card" key={draft.draftId}>
          <div className="meta">
            draft #{draft.draftId} · to <strong>{message?.from.address ?? 'unknown sender'}</strong>{' '}
            · re: {message?.subject ?? draft.providerMessageId} · staged {draft.createdAt}
          </div>
          <form action={approve}>
            <input type="hidden" name="draftId" value={draft.draftId} />
            <input type="hidden" name="originalBody" value={draft.body} />
            <textarea name="body" rows={8} defaultValue={draft.body} />
            <div className="actions">
              <button type="submit">Approve &amp; send (simulated)</button>
              <button type="submit" formAction={reject}>
                Reject
              </button>
            </div>
          </form>
        </div>
      ))}
      {decided.length > 0 && (
        <>
          <h2>Decided</h2>
          <table>
            <thead>
              <tr>
                <th>draft</th>
                <th>recipient</th>
                <th>status</th>
                <th>decided by</th>
                <th>sent at</th>
              </tr>
            </thead>
            <tbody>
              {decided.map(({ draft, approval, message }) => (
                <tr key={draft.draftId}>
                  <td>#{draft.draftId}</td>
                  <td>{message?.from.address}</td>
                  <td className="status">{approval?.status}</td>
                  <td>{approval?.decidedBy}</td>
                  <td>{approval?.sentAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
