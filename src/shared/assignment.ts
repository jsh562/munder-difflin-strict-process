/**
 * Re-export shim — the canonical assignment/provider-derivation logic moved into
 * @jsh562/won-agent-core (runtime extraction). Kept so existing `@shared/assignment` /
 * `../../shared/assignment` imports across the app keep resolving unchanged.
 */
export * from '../../packages/won-agent-core/src/contracts/assignment';
