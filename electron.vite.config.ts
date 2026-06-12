import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// E007 T010 {FR-009} — pin the EXPERIMENTAL OTel GenAI semantic-convention version
// for the main process + the native worker (built under `main`). Emission and the
// collector's gen_ai.* normalization both stay locked to this pin; it MUST match
// `PINNED_SEMCONV` in `src/main/telemetry.ts`. Injected as a compile-time define so
// the native worker can set `process.env.OTEL_SEMCONV_STABILITY_OPT_IN` at spawn.
const PINNED_SEMCONV = 'gen_ai_latest_experimental';

// The extracted runtime/toolkit library is consumed FROM SOURCE via this alias (not
// from a built dist), so there is no build-order dependency for the app to run. It is
// excluded from `externalizeDepsPlugin` so rollup bundles its TS source into BOTH main
// rollup inputs (the main process + the native `agentWorker` utilityProcess) and the
// renderer. Mirrors the existing `@shared` renderer alias.
const AGENT_CORE = '@jsh562/agent-core';
const AGENT_CORE_SRC = resolve(__dirname, 'packages/agent-core/src/index.ts');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [AGENT_CORE] })],
    resolve: {
      alias: { [AGENT_CORE]: AGENT_CORE_SRC }
    },
    define: {
      // Compile-time pin readable as `import.meta.env.OTEL_SEMCONV_STABILITY_OPT_IN`
      // (and asserted against telemetry.ts PINNED_SEMCONV) so the native worker
      // emits on the pinned semconv version (T010 / FR-009).
      'import.meta.env.OTEL_SEMCONV_STABILITY_OPT_IN': JSON.stringify(PINNED_SEMCONV)
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // E003 — the native agent worker entry, forked as an Electron
          // utilityProcess (built to out/main/agentWorker.js).
          agentWorker: resolve(__dirname, 'src/main/runtime/worker/agentWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@brand': resolve(__dirname, 'docs'),
        '@shared': resolve(__dirname, 'src/shared'),
        [AGENT_CORE]: AGENT_CORE_SRC
      }
    }
  }
});
