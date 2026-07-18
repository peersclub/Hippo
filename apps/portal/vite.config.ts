import { defineConfig } from 'vite'

// Same JSX convention as packages/sdk: esbuild automatic runtime, Preact.
// /api/* proxies to services/portal so cookies stay same-origin in dev.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.PORTAL_API_URL ?? 'http://localhost:8795',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
