/**
 * Re-export shim — the canonical provider registry moved into @jsh562/agent-core
 * (runtime extraction). Kept so existing `@shared/providerRegistry` /
 * `../../shared/providerRegistry` imports across the app keep resolving unchanged.
 */
export * from '../../packages/agent-core/src/contracts/providerRegistry';
