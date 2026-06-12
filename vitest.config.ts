import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// E001 — unit + integration tests for the provider runtime / event-bus seam.
// Node environment: the runtime, adapter, bus, and translator are main-process
// (Node) modules; tests mock node-pty / electron rather than launching the app.
export default defineConfig({
  // Resolve the extracted library from source (matches the electron-vite alias) so
  // both the app's tests and the package's own tests import `@jsh562/agent-core`.
  resolve: {
    alias: { '@jsh562/agent-core': resolve(__dirname, 'packages/agent-core/src/index.ts') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/**/*.test.ts'],
    // The Electron app is not built/launched in tests; only pure logic runs.
    // `forks` over `threads`: more isolated and avoids the intermittent
    // "No test suite found" flake the threads pool hits under concurrent transforms.
    pool: 'forks'
  }
});
