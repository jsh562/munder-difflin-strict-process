import { defineConfig } from 'vitest/config';

// E001 — unit + integration tests for the provider runtime / event-bus seam.
// Node environment: the runtime, adapter, bus, and translator are main-process
// (Node) modules; tests mock node-pty / electron rather than launching the app.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The Electron app is not built/launched in tests; only pure logic runs.
    pool: 'threads'
  }
});
