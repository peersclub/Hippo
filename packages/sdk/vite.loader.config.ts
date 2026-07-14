import { defineConfig } from 'vite'

// Stage 1: the loader. <5KB gz, zero dependencies, IIFE. Mounts the pill,
// lazy-imports the panel on first interaction. Size gate runs post-build.
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/loader.ts',
      formats: ['iife'],
      name: 'HippoLoader',
      fileName: () => 'loader.js',
    },
    target: 'es2020',
    minify: 'esbuild',
  },
})
