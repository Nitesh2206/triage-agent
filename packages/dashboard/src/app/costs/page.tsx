import { requireOperator } from '../../lib/auth';
import { stores } from '../../lib/stores';

export const dynamic = 'force-dynamic';

export default async function CostsPage() {
  await requireOperator(); // service-role reads: operator allowlist gate, not just a session
  const entries = await stores().costs.list();
  const byStage = new Map<string, { calls: number; tokens: number; usd: number }>();
  for (const e of entries) {
    const s = byStage.get(e.stage) ?? { calls: 0, tokens: 0, usd: 0 };
    s.calls += 1;
    s.tokens += e.inputTokens + e.outputTokens;
    s.usd += e.usd;
    byStage.set(e.stage, s);
  }
  const totalUsd = entries.reduce((s, e) => s + e.usd, 0);

  return (
    <main>
      <h1>Costs</h1>
      <table>
        <thead>
          <tr>
            <th>stage</th>
            <th>calls</th>
            <th>tokens</th>
            <th>usd</th>
          </tr>
        </thead>
        <tbody>
          {[...byStage.entries()].map(([stage, s]) => (
            <tr key={stage}>
              <td>{stage}</td>
              <td>{s.calls}</td>
              <td>{s.tokens}</td>
              <td>${s.usd.toFixed(4)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>total</strong>
            </td>
            <td>{entries.length}</td>
            <td>{entries.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0)}</td>
            <td>
              <strong>${totalUsd.toFixed(4)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <h2>Per call</h2>
      <table>
        <thead>
          <tr>
            <th>message</th>
            <th>stage</th>
            <th>model</th>
            <th>in</th>
            <th>out</th>
            <th>usd</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i}>
              <td>{e.providerMessageId}</td>
              <td>{e.stage}</td>
              <td>{e.model}</td>
              <td>{e.inputTokens}</td>
              <td>{e.outputTokens}</td>
              <td>${e.usd.toFixed(6)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
