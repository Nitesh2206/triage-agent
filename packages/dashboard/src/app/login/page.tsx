'use client';

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
    if (error) {
      setStatus('error');
      setMessage(error.message);
    } else {
      setStatus('sent');
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '4rem auto', fontFamily: 'system-ui' }}>
      <h1>Sign in</h1>
      {status === 'sent' ? (
        <p>Magic link sent — check your inbox.</p>
      ) : (
        <form onSubmit={sendLink}>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="operator email"
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
          />
          <button type="submit" style={{ padding: '8px 16px' }}>
            Send magic link
          </button>
          {status === 'error' && <p style={{ color: 'crimson' }}>{message}</p>}
        </form>
      )}
    </main>
  );
}
