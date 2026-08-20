import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { authClient } from '../../../lib/auth';

/** Magic-link landing: verify the emailed token, set the session, go home. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;

  if (tokenHash && type) {
    const supabase = await authClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL('/', request.url));
  }
  return NextResponse.redirect(new URL('/login', request.url));
}
