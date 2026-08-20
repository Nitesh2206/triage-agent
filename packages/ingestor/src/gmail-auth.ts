import { google, type gmail_v1 } from 'googleapis';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

export function hasGmailEnv(): boolean {
  const env = process.env;
  return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

/** Gmail API client from env credentials (desktop-app OAuth + refresh token). */
export function gmailClient(): gmail_v1.Gmail {
  if (!hasGmailEnv()) {
    throw new Error('missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN');
  }
  const env = process.env;
  const auth = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}
