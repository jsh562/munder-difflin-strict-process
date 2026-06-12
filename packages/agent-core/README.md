# @munder/agent-core

A **provider-agnostic agent runtime** (DeepSeek / Minimax / your own) plus a
**governed, sandboxed coding toolkit** — extracted from the Munder Difflin harness so
the same engine can host native LLM agents in **any** system ("bring your own host").

It is **host-agnostic and dependency-light**: no Electron, no provider SDKs, no UI.
Adapters take an injected `fetch`; everything the host owns (filesystem, memory,
mailbox, permissions, telemetry) is supplied through small injection interfaces. It
runs in plain Node and is exercised entirely under vitest.

## What's inside

- **Contracts** — `ProviderCall`, `ProviderRuntime`, `AgentEvent` (the normalized
  event stream), the provider registry (model/pricing/capabilities), and assignment
  helpers (`deriveProviderId`, …).
- **Runtime** — `runAgentLoop` (the provider-agnostic agentic loop: request → tool
  use → execute → repeat, emitting `AgentEvent`s), the streaming adapters
  (`makeDeepseekAdapter`, `makeMinimaxAdapter`, `selectAdapter`), the ADR-0009
  reliability/retry wrapper, the SSE parser, and the capability-degradation gate.
- **Toolkit** — `executeAgentTool` + `AGENT_TOOL_CATALOG`: filesystem
  (`read_file`/`write_file`/`edit_file`/`list_dir`), search (`grep`), shell (`bash`,
  opt-in), durable memory (`write_memory`), and the hive coordination tools. Every
  path tool is **cwd-sandboxed**; `bash` is **off until the host enables it**.

## Host-injection seams

| Seam | You provide | The package gives back |
|---|---|---|
| `ProviderCall` | an injected `fetch` + key/endpoint/model (or env via `selectAdapter`) | a streaming provider round-trip |
| `AgentLoopDeps` | `executeTool`, `emit`, `requestDrain` | `runAgentLoop` drives the agentic cycle |
| `AgentToolDeps` | `resolveCwd`, `appendMemory`, the hive surface, `bashEnabled` | `executeAgentTool` runs governed, sandboxed tools |
| Credential env | `NATIVE_PROVIDER_ID` / `NATIVE_PROVIDER_API_KEY` / `NATIVE_PROVIDER_MODEL` | `selectAdapter(env, { fetch })` picks the adapter |

Permission gating and a circuit breaker are **the host's responsibility** — wire them
around `executeTool` (the Munder Difflin host gates pause/halt/gated-tool, then feeds a
breaker, then calls `executeAgentTool`).

## Minimal usage (no Electron)

```ts
import {
  makeDeepseekAdapter, runAgentLoop, executeAgentTool,
  AGENT_TOOL_CATALOG, NATIVE_AGENT_PREAMBLE, type AgentToolDeps
} from '@munder/agent-core';

// 1) A provider call (or: selectAdapter(process.env, { fetch: globalThis.fetch })).
const providerCall = makeDeepseekAdapter({
  fetch: globalThis.fetch,
  apiKey: process.env.DEEPSEEK_API_KEY!,
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-pro'
});

// 2) Wire the toolkit to YOUR host. resolveCwd is the per-agent sandbox root; the
//    hive surface can be stubbed for a single agent. bash stays off unless enabled.
const toolDeps: AgentToolDeps = {
  enabled: () => true,
  memory: () => '',
  appendMemory: (_id, _text) => { /* persist a durable note */ },
  send: (m) => ({ ...m } as never),     // mailbox — stub for a single agent
  tasks: () => ({ tasks: [] }),
  writeTasks: () => {},
  resolveCwd: () => process.cwd(),       // the agent's sandbox root
  bashEnabled: () => false               // opt-in shell
};

// 3) Run the agentic loop. Tool calls route through the governed executor.
await runAgentLoop({
  agentId: 'agent-1',
  providerCall,
  tools: [...AGENT_TOOL_CATALOG],
  systemPrompt: NATIVE_AGENT_PREAMBLE,
  emit: (event) => console.log(event.kind),
  executeTool: async (use) => ({ toolCallId: use.toolCallId, ...(await executeAgentTool(toolDeps, 'agent-1', use)) }),
  requestDrain: async () => ({ block: false }),
  caps: { maxTurns: 20, maxHops: 20 }
}, 'List the files in the working directory and summarize the README.');
```

## Scripts

- `npm run build` — emit `dist/` (JS + `.d.ts`) for external consumers.
- `npm run typecheck` — strict typecheck.
- `npm test` — the package's own vitest suites.

## Boundary

The package must stay host-agnostic: no `electron`, no `node-pty`, and no import back
into a host app's `src/**`. It MAY use Node builtins. This is enforced statically (an
ESLint `no-restricted-imports` boundary on `packages/agent-core/src/**`) and at runtime
(`boundary.test.ts` asserts the contracts leak no provider-specific symbol).
