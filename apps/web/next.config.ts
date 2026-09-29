import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @docqa/contracts ships TypeScript source rather than a build artifact:
  // it is types only, so compiling it with the app avoids a build step that
  // would exist purely to satisfy the module system.
  transpilePackages: ['@docqa/contracts'],
};

export default nextConfig;
