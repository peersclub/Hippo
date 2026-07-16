import { resolve } from 'node:path'
import { defineConfig, type PluginOption } from 'vite'

// Clean URL for the design-language page: /design → design.html in dev and
// preview. Static hosts (Vercel/Netlify cleanUrls) do the same in production.
const cleanUrls: PluginOption = {
  name: 'clean-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.split('?')[0] === '/design') req.url = '/design.html'
      next()
    })
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.split('?')[0] === '/design') req.url = '/design.html'
      next()
    })
  },
}

// Same trick as host-demo: the SDK's built bundles (loader.js, panel.js) are
// served from the web root, exactly as a CDN would — so the landing page's
// "try it" demo is the real product, not a mock-up of it.
export default defineConfig({
  publicDir: '../../packages/sdk/dist',
  plugins: [cleanUrls],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        design: resolve(import.meta.dirname, 'design.html'),
      },
    },
  },
})
