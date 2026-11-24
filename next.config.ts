import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  reactStrictMode: true,
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into the repo root (Next >= 16.3).
  agentRules: false,
  // better-sqlite3 >= 12 ships its binaries in prebuilds/<platform>-<arch>.node and picks one with a
  // computed path, which file tracing cannot see. Without this the standalone output has no native addon.
  outputFileTracingIncludes: { '/*': ['./node_modules/better-sqlite3/prebuilds/*.node'] },
};

export default nextConfig;
