/**
 * Re-export shim — the canonical AgentEvent contract moved into @jsh562/won-agent-core
 * (runtime extraction). Kept so existing `@shared/agentEvent` / `../../shared/agentEvent`
 * imports across the app + renderer keep resolving unchanged.
 */
export * from '../../packages/won-agent-core/src/contracts/agentEvent';
