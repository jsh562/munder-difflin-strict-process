# Internal Interface Contract — Provider Credential Management (E004)

Internal TypeScript interfaces (no network API). References: ADR-0007 (plaintext-config secrets), `src/main/config.ts` (HarnessConfig + Slack-secret precedent), E002 `src/shared/providerRegistry.ts` (`listProviders`), E003 `electronWorkerTransport` (spawn env). The testable core is PURE (type-only import of `HarnessConfig` → no electron at runtime); the electron-coupled wiring (readConfig/writeConfig/listProviders) is thin.

## Store shape (`src/main/config.ts`)

Add one optional field to `HarnessConfig`, persisted in `config.json` under the OS app-data dir (outside any repo), alongside the existing `slackSigningSecret`/`slackBotToken`:

- `providerKeys?: Record<string, string>` — provider id → API key.

## Pure credential logic (`src/main/credentials.ts`) — electron-free, vitest-tested

Operates on a passed config + a known-provider list (no electron import):

- `setKeyInConfig(cfg, providerId, key, knownProviderIds): HarnessConfig` — returns a new config with the key set; **throws/rejects** when `providerId` ∉ `knownProviderIds`.
- `getKeyFromConfig(cfg, providerId): string | null` — the key, or null.
- `clearKeyInConfig(cfg, providerId): HarnessConfig` — returns a new config without that key.
- `keyPresence(cfg, knownProviderIds): Record<string, boolean>` — provider id → has-key (values never included).
- `injectionEnvForProvider(cfg, providerId): Record<string, string> | null` — the spawn env to inject (e.g. `{ NATIVE_PROVIDER_API_KEY: <key>, NATIVE_PROVIDER_ID: <providerId> }`), or **null** when no key (TR-007: no empty/garbage env). The single swap point a future OS-keychain backend replaces (TR-006).
- `redactConfig(cfg): SafeConfig` — `Omit<HarnessConfig, 'providerKeys'> & { providerKeyPresence: Record<string, boolean> }`. The ONLY shape sent to the renderer (TR-008).

## Live wiring (`src/main/index.ts`, electron-coupled)

- `config:get` IPC handler returns **`redactConfig(readConfig())`** — the renderer gets presence, never values.
- New IPC: `credentials:set(providerId, key)` / `credentials:clear(providerId)` → validate vs `listProviders()` (E002), apply the pure fn, `writeConfig`. `credentials:presence()` → `keyPresence`.
- Native worker spawn (E003 `electronWorkerTransport`/`nativeRuntime`) injects `injectionEnvForProvider(readConfig(), providerId)` into the `utilityProcess` fork `env` (the provider id is supplied by E005 assignment later; parameterized until then).

## Non-leakage boundaries (TR-004/SC-004)

- `credentials.ts` imports nothing from `hive`, `telemetry`, or transcript modules — the key value flows only: store (config.json) → injection seam → worker `env`.
- The renderer path is redacted (`redactConfig`). The hive is never written with a key (worker is a separate process; main writes keys only to config.json). Telemetry stays allowlisted (no credential attribute). The SC-004 test asserts the key value is absent from the redacted config, and that the module has no hive/telemetry/transcript import.

## Renderer (minimal)

A Settings surface shows per-provider key presence and lets the operator enter (sends value renderer→main via `credentials:set`) or clear a key. The value is never sent main→renderer.
