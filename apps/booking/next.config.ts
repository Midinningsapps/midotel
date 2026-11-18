import type { NextConfig } from 'next';

const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  // Guests' browsers only talk to this origin; /api/* is proxied to the Midotel API.
  async rewrites() {
    return [{ source: '/api/public/:path*', destination: `${api}/public/:path*` }];
  },
};

export default config;
