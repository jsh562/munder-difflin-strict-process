---
feature_branch: "00004-provider-credential-management"
created: "2026-06-08"
input: "E004 Provider credential management"
spec_type: "technical"
spec_maturity: "draft"
epic_id: "E004"
epic_sources: "{SAD:ADR-0007}{PRD:CAP-014}"
---

# Feature Specification: Provider Credential Management

**Feature Branch**: `00004-provider-credential-management`  
**Created**: 2026-06-08  
**Status**: Draft  
**Spec Type**: technical  
**Spec Maturity**: draft  
**Epic ID**: E004  
**Epic Sources**: {SAD:ADR-0007}{PRD:CAP-014}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

A native (non-Claude) agent needs its provider's API key to make any model call, but the harness has no place to keep those keys and no way to hand the right key to a worker. Without a credential store and a spawn-time injection seam, DeepSeek/Minimax agents cannot authenticate — and any naive approach risks leaking a key into the shared git hive, the transcripts, or the telemetry stream, which would be a serious exposure. This epic provides the store and the injection seam, with strict non-leakage; plaintext-at-rest is the accepted MVP storage (ADR-0007), and the seam is built so a future OS-keychain backend swaps in without changing consumers.

## Scope *(mandatory)*

### Included

- A multi-provider credential store: one API key per provider (keyed by the E002 provider id), persisted in the harness config (config.json under the OS app-data dir — outside any registered repo), with set / retrieve / clear.
- A minimal operator surface to enter, update, and clear a provider's key.
- A key-injection-at-spawn seam that returns the credential for a provider and is the single point the native worker spawn (E003) uses to inject the key into the worker's environment.
- Strict non-leakage: keys never reach the git hive, the transcripts, or the OTel/telemetry output; the store lives outside any registered repo (and any repo-adjacent path is gitignored).
- The injection seam designed as the single swap point for a later OS-keychain backend (no consumer change).

### Excluded

- OS-keychain / `safeStorage` encryption of keys at rest — deferred hardening (ADR-0007); the seam is reused.
- Per-agent / fleet provider & model assignment (which provider an agent uses) — E005.
- Real DeepSeek/Minimax adapters that consume the injected key — E006.
- A full credential-management GUI beyond the minimal key-entry surface.
- Claude/Anthropic authentication (Claude agents use their own login, not a key from this store).

### Edge Cases & Boundaries

- A provider has no key set → spawn gets a clear "no credential" signal (no crash, no empty/garbage env), surfaced to the operator.
- A key is set for an unknown/unseeded provider id → rejected (the store only accepts known E002 providers).
- A key is updated or cleared while an agent is running → the change applies to the next spawn; running workers keep their injected key.
- The harness config is reset → credentials are cleared with it (they live in the same store).
- A key value happens to look like other content → it must still never appear in hive/transcript/telemetry writes (value-level non-leakage, not just field-name).

## Technical Objectives *(mandatory for technical specs only)*

### Objective 1 - Multi-provider credential store (Priority: P1)

Store one API key per provider, keyed by the E002 provider id, persisted in the harness config, with set / retrieve / clear and a minimal operator entry surface.

**Why this priority**: Without somewhere to keep provider keys, no native agent can authenticate — E006 depends on this store existing.

**Rationale**: Reusing the existing harness-config store (which already holds secrets like the Slack tokens, outside any repo) is the simplest correct MVP and matches ADR-0007.

**Deliverables**:
- A `CredentialRecord` store (provider id → API key) implemented under `/src`, persisted in the harness config (the OS app-data file, outside any repo) across restart, with set/get/clear.
- A minimal operator surface to enter/update/clear a provider's key.

**Validation Criteria**:
1. **Given** the store, **When** an operator sets a provider's key, **Then** it persists across restart and can be retrieved and cleared.
2. **Given** an unknown provider id, **When** a key is set for it, **Then** the store rejects it (only known E002 providers).

### Objective 2 - Key-injection-at-spawn seam (Priority: P1)

Provide the single seam that returns a provider's credential and injects it into the native worker at spawn — reusable for a future OS-keychain backend.

**Why this priority**: The key only matters if it reaches the worker; the seam is the contract E003's spawn and E006's adapters depend on.

**Rationale**: A single injection seam keeps the storage backend swappable (plaintext now, keychain later) without touching the worker or adapters.

**Deliverables**:
- An injection seam: given a provider id, return the credential / spawn-env to inject; wired into the native worker spawn (E003).
- A documented "single swap point" boundary so a later keychain backend replaces only the seam's storage side.

**Validation Criteria**:
1. **Given** a stored key, **When** a native worker spawns for that provider, **Then** the seam injects the key into the worker's environment and nowhere else.
2. **Given** no stored key, **When** the seam is asked for a provider's credential, **Then** it returns a clear "no credential" result (no crash, no empty env injected).

### Objective 3 - Strict non-leakage (Priority: P1)

Guarantee keys never reach the git hive, the transcripts, or the OTel/telemetry output, and that the store lives outside any registered repo.

**Why this priority**: Plaintext-at-rest is accepted, but leaking a key into the shared hive/transcripts/telemetry would be a real exposure — non-leakage is the security property of this epic.

**Rationale**: The hive is shared/audited and telemetry is exported; a credential in either is far worse than one in a local app-data file.

**Deliverables**:
- Boundaries ensuring the key value is written only to the credential store and the worker's spawn env — never to hive files, transcripts, or telemetry attributes.
- The store located outside any registered repo; any repo-adjacent path gitignored.

**Validation Criteria**:
1. **Given** a set key, **When** the hive, transcripts, and telemetry write paths are exercised, **Then** the key value appears in none of them.
2. **Given** the store's location, **When** checked, **Then** it is outside any registered repo (or gitignored if repo-adjacent).

### Technical Constraints

- Plaintext at rest is the accepted MVP storage (ADR-0007); the enforced security property is non-leakage to hive / transcripts / telemetry.
- The injection seam MUST be the single point a future OS-keychain backend swaps behind, with no consumer change.
- The injected key MUST be scoped to the worker process (spawn env / IPC) and never exposed to the renderer or other agents.
- The credential store MUST live outside any registered repo; repo-adjacent paths MUST be gitignored.
- All source under `/src`; `npm run typecheck`, `npm run lint`, `npm run test:run` stay green.

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: Reads the provider list from the E002 registry (`src/shared/providerRegistry.ts` `listProviders`) so the store only holds keys for known providers.
- **IP-002**: Persisted via the harness config (`src/main/config.ts` `readConfig`/`writeConfig`, under the OS app-data dir), following the existing secret precedent (`slackSigningSecret`/`slackBotToken`, "never logged").
- **IP-003**: The injection seam is consumed by the native worker spawn (E003 `electronWorkerTransport`/`nativeRuntime`) to set the worker's env; E006 adapters read the injected key.
- **IP-004**: Non-leakage boundaries — keys never written to the hive (`src/main/hive.ts`), transcripts (`~/.claude`), or OTel output (`src/main/telemetry.ts`, already PII-scrubbed).

## Requirements *(mandatory)*

### Technical Requirements *(technical specs only)*

- **TR-001**: System MUST store one API key per provider, keyed by the E002 provider id, in the harness config, persisted across restart, with set / retrieve / clear.
- **TR-002**: The store MUST read the provider list from the E002 registry and reject keys for unknown provider ids.
- **TR-003**: System MUST provide a key-injection-at-spawn seam that returns a provider's credential and is the single point the native worker spawn (E003) uses to inject the key into the worker's environment.
- **TR-004**: Keys MUST NEVER be written to the git hive (board, log, registry, agent files), to Claude transcripts, or to OTel/telemetry output.
- **TR-005**: The credential store MUST live outside any registered repo; a repo-adjacent location MUST be gitignored.
- **TR-006**: Plaintext at rest is the accepted MVP storage (ADR-0007); the injection seam MUST be the single seam a future OS-keychain backend swaps behind without changing the worker or adapters.
- **TR-007**: A missing/unset key MUST yield a clear "no credential" result at spawn (no crash; no empty/garbage env injected).
- **TR-008**: The injected key MUST be scoped to the worker process and never exposed to the renderer or other agents.

### Key Entities *(include for product or technical specs if feature involves data)*

- **CredentialRecord**: One provider's stored credential — `{ providerId, apiKey }`, keyed by the E002 provider id, persisted in the harness config.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The harness config (config.json under the OS app-data dir) is outside any registered repo and is the credential-store location, following the existing Slack-secret precedent.
- The E002 provider list identifies which providers need keys (DeepSeek, Minimax; Claude uses its own login).
- The E003 native worker spawn (utilityProcess fork) is the injection point (env at spawn).
- Operators supply their own provider API keys.

### Risks

- **Plaintext at rest** *(likelihood: high, impact: medium — accepted)*: anyone with read access to the config file obtains live keys. Mitigation: explicitly accepted for the MVP (ADR-0007); non-leakage enforced; OS-keychain hardening reuses the same seam.
- **Accidental leakage to hive / transcripts / telemetry** *(likelihood: low-medium, impact: high)*: the real security failure. Mitigation: strict write boundaries + a test asserting the key value is absent from those outputs (TR-004/SC-004).
- **Key visible in worker process environment** *(likelihood: low, impact: medium)*: env vars are inspectable by the local user. Mitigation: accepted under local trust; an IPC-injection alternative is noted as a later option behind the same seam.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — `CredentialRecord` (provider id → API key).
- `NEW-CONFIG` — the credential-store fields in the harness config.
- `NEW-API` — the key-injection-at-spawn seam (internal interface) + store set/get/clear.
- `NEW-UI` — a minimal operator surface to enter/update/clear a provider's key.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: An operator can set, retrieve, and clear an API key per provider, and the keys persist across a restart (verified by a test).
- **SC-002** [OBJ1]: The store is keyed by E002 provider ids and rejects keys for unknown providers (test).
- **SC-003** [OBJ2]: The injection seam returns the correct credential for a provider and is the single point the native worker spawn uses to inject it into the worker env (test).
- **SC-004** [OBJ3]: A set key's value appears in **none** of the hive write paths, the transcripts, or the emitted telemetry (verified by a value-level absence test).
- **SC-005** [OBJ3]: The credential store resides outside any registered repo (or is gitignored if repo-adjacent), verified.
- **SC-006** [OBJ2]: A missing key yields a clear "no credential" result at spawn — no crash, no empty/garbage env injected (test).
- **SC-007** [OBJ3]: The injected key is scoped to the worker process and not exposed to the renderer or other agents (verified).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| CredentialRecord | One provider's stored credential (provider id → API key) in the harness config. |
| Key-injection-at-spawn seam | The single function that hands a provider's credential to the native worker at spawn (env/IPC); the swap point for a future keychain backend. |
| Non-leakage | The guarantee that a key value is never written to the git hive, transcripts, or telemetry output. |
| Plaintext-at-rest | The accepted MVP storage posture (ADR-0007): keys stored unencrypted in the harness config file outside any repo. |
| Harness config | `config.json` under the OS app-data dir — the persisted store, outside any registered repo (holds existing secrets too). |

## Compliance Check

**Result**: PASS — `project-instructions.md` v1.0.0 · **Audited**: 2026-06-08

| Principle / Rule | Verdict |
|------------------|---------|
| Governance — secret non-leakage (ADR-0007) | PASS |
| I. Provider-Agnostic Parity | PASS |
| II. Truthful Cost Governance | N/A |
| III. Crash-Contained Isolation & Resilience | PASS |
| IV. Agent Output Style | PASS |
| V. Preserve the Proven Core & Type Safety | PASS |
| Source Code Layout (ENFORCE_SRC_ROOT) | PASS |
| Governance out-of-scope guard | PASS |

- Plaintext-at-rest is the **accepted** MVP risk per ADR-0007 (not a new decision); the spec enforces non-leakage (TR-004/005/008, SC-004/005/007) and reuses the single injection seam (TR-006) for the deferred OS-keychain hardening.
- Store keyed by E002 provider id; unknown providers rejected; the injection seam is provider-agnostic (I). Reuses the existing harness-config secret store (Slack-token precedent); all under `/src`; typecheck/lint/test gated; runtime unchanged (V).
- Scoped deferrals (keychain hardening, assignment→E005, real adapters→E006, Claude auth) are bounded, not violations.

**Plan-phase advisories**: bind the SC-004 value-level absence test to each named write path (hive board/log/registry/agent files, `~/.claude` transcripts, `telemetry.ts` output); the accepted worker-env key visibility has an IPC-injection alternative behind the same seam.

**Remediations**: None.
