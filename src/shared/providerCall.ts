/**
 * Re-export shim — the canonical ProviderCall contract moved into @munder/agent-core
 * (runtime extraction). Kept so existing `@shared/providerCall` / `../../shared/providerCall`
 * imports across the app keep resolving unchanged.
 */
export * from '../../packages/agent-core/src/contracts/providerCall';
