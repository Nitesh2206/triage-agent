import type { ReactNode } from 'react';

export const metadata = { title: 'triage-agent dashboard' };

const css = `
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 72rem; }
  nav { display: flex; gap: 1rem; margin-bottom: 1.5rem; border-bottom: 1px solid #8884; padding-bottom: 0.75rem; }
  nav a { text-decoration: none; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-size: 0.75rem; text-transform: uppercase; opacity: 0.7; }
  textarea { width: 100%; font: inherit; box-sizing: border-box; }
  button { font: inherit; padding: 0.3rem 0.8rem; cursor: pointer; }
  .refused { color: #c0392b; font-weight: 600; }
  .status { font-weight: 600; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .meta { font-size: 0.8rem; opacity: 0.75; margin-bottom: 0.5rem; }
  .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{css}</style>
      </head>
      <body>
        <nav>
          <a href="/">Approvals</a>
          <a href="/audit">Audit log</a>
          <a href="/costs">Costs</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
