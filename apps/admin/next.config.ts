import type { NextConfig } from 'next';

const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  transpilePackages: ['@midotel/sections'],
  // The browser only talks to this origin; /api/* is proxied to the API so the session cookie stays first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};

export default config;
