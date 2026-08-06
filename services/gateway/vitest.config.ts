import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Suite-wide capability parity assertion — see the file's header.
    setupFiles: ['./test/setup-capability-parity.ts'],
  },
})
