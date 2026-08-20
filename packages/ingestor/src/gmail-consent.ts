/**
 * One-time local consent: mints the GMAIL_REFRESH_TOKEN for the headless cron.
 * Run: pnpm --filter @triage/ingestor gmail:consent
 * (needs GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET of a "Desktop app" OAuth client)
 */
import { createServer } from 'node:http';
import { google } from 'googleapis';
import { GMAIL_SCOPES } from './gmail-auth.js';

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first');
  process.exit(1);
}

const port = 53682;
const redirectUri = `http://127.0.0.1:${port}/callback`;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force a refresh token even on re-consent
  scope: GMAIL_SCOPES,
});
console.log('Open this URL in a browser and approve:\n\n' + url + '\n');

const server = createServer((req, res) => {
  void (async () => {
    const code = new URL(req.url ?? '/', redirectUri).searchParams.get('code');
    if (!code) {
      res.writeHead(400).end('missing code');
      return;
    }
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Done — refresh token printed in the terminal. You can close this tab.');
    console.log('\nAdd to .env and GitHub Actions secrets:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    server.close();
  })().catch((e: unknown) => {
    res.writeHead(500).end('token exchange failed');
    console.error(e);
    server.close();
    process.exit(1);
  });
});
server.listen(port, '127.0.0.1');
