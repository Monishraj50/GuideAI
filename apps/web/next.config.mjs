/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy /api/* to the Fastify orchestrator so SSE and REST calls go through
  // a single origin during dev.
  async rewrites() {
    const target = process.env.GUIDEAI_API_BASE ?? 'http://localhost:4000';
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
      { source: '/healthz', destination: `${target}/healthz` },
    ];
  },
};
export default nextConfig;
