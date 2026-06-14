/**
 * Re-export shim — the canonical provider registry moved into @jsh562/won-agent-core
 * (runtime extraction). Kept so existing `@shared/providerRegistry` /
 * `../../shared/providerRegistry` imports across the app keep resolving unchanged.
 */
export * from '../../packages/won-agent-core/src/contracts/providerRegistry';
