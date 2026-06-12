/**
 * Re-export shim — the canonical ProviderRuntime contract moved into
 * @munder/agent-core (runtime extraction). Kept so existing `@shared/providerRuntime`
 * / `../../shared/providerRuntime` imports across the app keep resolving unchanged.
 */
export * from '../../packages/agent-core/src/contracts/providerRuntime';
