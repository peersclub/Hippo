import { defineConfig } from 'vite'

// The SDK's built bundles (loader.js, panel.js) are served from the web root,
// exactly as a CDN would. `pnpm dev` at the repo root builds the SDK in watch
// mode alongside this server.
export default defineConfig({
  publicDir: '../../packages/sdk/dist',
})
