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
  // BeatLeader's .bplist files embed a multi-megabyte cover image, and the
  // default 1 MB cap rejected them before the import's own 25 MB check ran.
  experimental: { serverActions: { bodySizeLimit: '25mb' } },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
