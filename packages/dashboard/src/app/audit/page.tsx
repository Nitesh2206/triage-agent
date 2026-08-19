import { stores } from '../../lib/stores';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const entries = await stores().audit.list();
  const refused = entries.filter((e) => !e.allowed).length;
  return (
    <main>
      <h1>Audit log</h1>
      <p>
        {entries.length} rows · <span className="refused">{refused} refused</span>
      </p>
      <table>
        <thead>
          <tr>
            <th>actor</th>
            <th>action</th>
            <th>phase</th>
            <th>allowed</th>
            <th>tier</th>
            <th>message</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i}>
              <td>{e.actor}</td>
              <td>{e.action}</td>
              <td>{e.phase}</td>
              <td className={e.allowed ? '' : 'refused'}>{e.allowed ? 'yes' : 'REFUSED'}</td>
              <td>{e.trustTier ?? '—'}</td>
              <td>{e.providerMessageId ?? '—'}</td>
              <td>
                <code>{JSON.stringify(e.detail ?? {})}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
