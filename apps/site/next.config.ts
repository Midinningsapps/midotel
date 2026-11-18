import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@midotel/sections'],
  images: { unoptimized: true },
};

export default config;
