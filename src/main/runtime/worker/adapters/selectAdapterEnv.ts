/**
 * Native-provider env var NAMES the worker reads at spawn (E006 / FR-008/013).
 *
 * Kept as a tiny, dependency-free module so the electron-free adapter layer
 * (`selectAdapter`) can reference the env keys without importing any `src/main/*`
 * module into the worker bundle. The values MUST match `src/main/credentials.ts`
 * (the spawn-side writer): a single source of truth via re-export there.
 */
export const NATIVE_PROVIDER_API_KEY_ENV = 'NATIVE_PROVIDER_API_KEY';
export const NATIVE_PROVIDER_ID_ENV = 'NATIVE_PROVIDER_ID';
export const NATIVE_PROVIDER_MODEL_ENV = 'NATIVE_PROVIDER_MODEL';
