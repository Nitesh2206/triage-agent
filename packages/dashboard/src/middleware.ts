import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * Session refresh + auth wall. Unauthenticated requests are redirected to
 * /login (fail closed — a missing/invalid session never reaches a page).
 * Operator-allowlist enforcement happens server-side in requireOperator();
 * this only guarantees a verified sign-in.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: { name: string; value: string; options: CookieOptions }[]) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/auth');
  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Everything except static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
