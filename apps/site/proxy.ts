// Serves each hotel's website on its own domain: a request to www.hotel.com/rooms is rendered
// from /s/www.hotel.com/rooms. Platform hosts (previews, health checks) are left alone.
import { NextResponse, type NextRequest } from 'next/server';

const PLATFORM_HOSTS = new Set(
  (process.env.SITE_PLATFORM_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

export function proxy(request: NextRequest) {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  const { pathname } = request.nextUrl;
  if (!host || PLATFORM_HOSTS.has(host) || pathname.startsWith('/s/') || pathname.startsWith('/preview')) {
    return NextResponse.next();
  }
  const url = request.nextUrl.clone();
  url.pathname = `/s/${encodeURIComponent(host)}${pathname === '/' ? '' : pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // Skip Next.js assets and files with an extension (robots.txt, favicon.ico, images).
  matcher: ['/((?!_next/|.*\\.[a-zA-Z0-9]+$).*)'],
};
