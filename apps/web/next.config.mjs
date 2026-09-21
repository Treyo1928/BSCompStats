/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output keeps the runtime image small: Next traces exactly the
  // files it needs instead of shipping the whole node_modules tree.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  transpilePackages: ['@bscs/core', '@bscs/db'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.beatleader.com' },
      { protocol: 'https', hostname: '*.beatleader.xyz' },
      { protocol: 'https', hostname: '*.beatsaver.com' },
      { protocol: 'https', hostname: 'cdn.discordapp.com' },
    ],
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
