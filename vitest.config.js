import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.js'],
    setupFiles: ['./tests/setup-env.js'],
    include: ['tests/**/*.test.js'],
    // Every file shares one aubounty_test database and truncates it in
    // beforeEach, so files must not overlap mid-run.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 60000,
  },
})
