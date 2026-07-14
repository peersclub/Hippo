import { defineConfig } from 'vite'

// Stage 2: the panel. Preact + signals + card renderer, single ESM chunk,
// dynamically imported by the loader. Bundles everything (no externals) —
// the host page owes us nothing.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/panel.tsx',
      formats: ['es'],
      fileName: () => 'panel.js',
    },
    target: 'es2020',
    minify: 'esbuild',
  },
})
