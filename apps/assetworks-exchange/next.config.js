const path = require("node:path")

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root (multiple lockfiles exist above this dir).
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // The venue backend (host-venue) already sends permissive CORS, but proxying
  // keeps the browser same-origin and mirrors AssetWorks' app/api/proxy pattern.
  async rewrites() {
    const venue = process.env.HOST_VENUE_URL ?? 'http://localhost:8796'
    return [{ source: '/venue/:path*', destination: `${venue}/:path*` }]
  },
}

module.exports = nextConfig
