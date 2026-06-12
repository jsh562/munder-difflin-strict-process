/**
 * Re-export shim — the canonical AgentEvent contract moved into @munder/agent-core
 * (runtime extraction). Kept so existing `@shared/agentEvent` / `../../shared/agentEvent`
 * imports across the app + renderer keep resolving unchanged.
 */
export * from '../../packages/agent-core/src/contracts/agentEvent';
