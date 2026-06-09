---
feature_branch: "00005-model-and-provider-assignment"
created: "2026-06-08"
input: "Per-agent and fleet-default provider/model selection with capability-aware warnings."
spec_type: "product"
spec_maturity: "draft"
epic_id: "E005"
epic_sources: "{PRD:CAP-013,CAP-018}{SAD:ADR-0008}"
---

# Feature Specification: Model and Provider Assignment

**Feature Branch**: `00005-model-and-provider-assignment`  
**Created**: 2026-06-08  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: draft  
**Epic ID**: E005  
**Epic Sources**: {PRD:CAP-013,CAP-018}{SAD:ADR-0008}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

The harness now knows about multiple providers and models (E002 registry) and can store their credentials (E004), but the operator still cannot choose which provider/model a given agent runs on — every desk falls back to a hard-coded role-based model. Without an explicit assignment surface, the multi-provider investment is unusable: an operator cannot put one desk on DeepSeek and another on Claude, cannot set a house default, and gets no warning when a chosen model lacks a capability the work needs. The result is silent surprises (a desk quietly missing image or web-search support) and no way to control cost/capability per desk.

## Scope *(mandatory)*

### Included

- A per-agent provider+model assignment the operator sets when adding an agent and can change later per desk, with options read from the E002 registry.
- A fleet-default provider+model that applies to newly created agents that don't specify their own.
- A non-blocking, capability-aware warning shown at assignment time when the chosen model lacks one or more capabilities (images, MCP tools, web search, caching), so the operator chooses with eyes open.
- Durable persistence of both per-agent assignments and the fleet default across app restart.
- The assignment feeding the existing agent-creation path so the assigned model is the one the agent uses; the provider is recorded (and derivable from the model via the registry) for downstream consumers (E006, E010).
- Programmatic assignment by the GOD agent through the same assignment mechanism the operator uses.

### Excluded

- Runtime graceful degradation of unsupported capability paths (skip/no-op tool calls with a notice at execution time) — that is the runtime half of ADR-0008 and belongs to E006 / the native runtime, not assignment.
- Actually routing/executing an agent on a native (non-Claude) provider runtime — E006 consumes this epic's AgentAssignment; E005 only records and surfaces it.
- Live hot-swap "switch parity" that preserves a running desk's memory, mailbox, budget, telemetry, breaker, and avatar when its model/provider changes (CAP-019) — a separate epic; E005 changes the assignment record, not in-flight state migration.
- Editing the provider/model registry or capability descriptors — E005 is a read-only consumer of the E002-owned registry.
- Credential entry/management — owned by E004; E005 only reads credential presence to annotate the picker.

### Edge Cases & Boundaries

- Chosen model's provider has no API key stored: the model is shown with a "needs credentials" affordance; selecting it is allowed (not blocked) but flagged.
- No providers/models available at all (empty or unreadable registry): the picker shows an empty-state pointing to setup; agent creation falls back to the existing default behavior.
- A model previously assigned is later removed from the registry: the stored assignment is preserved and marked stale, prompting re-selection — never silently remapped to a different provider.
- The fleet default is changed after agents already exist: existing agents keep their current assignment (explicit or previously inherited); only agents created afterward pick up the new default.
- The assigned model lacks a capability: a clear warning is surfaced at assignment; the assignment still succeeds.
- The chosen model is BOTH uncredentialed (its provider has no key) AND capability-gapped: both annotations are surfaced together (the "needs credentials" affordance and the capability-gap warning naming each missing capability), and neither blocks selection — the assignment still succeeds (FR-009, FR-010).
- Conflicting concurrent edits to the shared Add-Agent drawer / config schema with E004: assignment fields and credential fields are additive and independently keyed (no overwrite of the other's data).

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Assign a provider and model to a new agent (Priority: P1)

When adding an agent, the operator picks a provider and a model from the registry-backed picker (grouped by provider). The new agent is created bound to that model, and the choice is recorded against the agent so it survives restart. If the operator picks nothing, the agent uses the fleet default (US2), and if no default is set, the existing role-based fallback applies.

**Why this priority**: Core value proposition of the epic — without a per-agent assignment surface the multi-provider registry and credentials cannot be used at all; every downstream epic (E006 execution, E010 rendering) consumes this assignment.

**Independent Test**: Add an agent, choose a specific provider+model in the drawer, confirm the agent is created using that model and that the model is shown on the agent after a restart.

**Acceptance Scenarios**:

1. **Given** the registry lists providers and models, **When** the operator opens the Add-Agent drawer, **Then** a provider-grouped model picker is shown with each model's provider and capability tags visible.
2. **Given** the operator selects provider P and model M, **When** they create the agent, **Then** the agent is created bound to M and an assignment record (model + derived provider, source = explicit) is stored for that agent.
3. **Given** an agent was created with an explicit model, **When** the app is restarted, **Then** the same provider+model is still associated with that agent.
4. **Given** the operator selects no model and no fleet default is set, **When** they create the agent, **Then** the agent is created with the existing role-based default and no explicit assignment is recorded.

### User Story 2 - Set a fleet-default provider and model (Priority: P1)

The operator sets a house default provider+model. Every newly created agent that doesn't choose its own provider/model inherits this default. Changing the default later affects only agents created after the change; existing agents are untouched.

**Why this priority**: Required MVP acceptance criterion — a single default is how an operator runs a whole floor on a chosen provider without configuring every desk; it is the inheritance baseline US1 falls back to.

**Independent Test**: Set a fleet default, add a new agent without choosing a model, and confirm it uses the default; then change the default and confirm existing agents keep their prior model while a newly added agent uses the new default.

**Acceptance Scenarios**:

1. **Given** no fleet default is set, **When** the operator sets the default to provider P / model M, **Then** the default persists and is shown as the current house default.
2. **Given** a fleet default of M, **When** the operator adds an agent without picking a model, **Then** that agent inherits M and is marked as using the fleet default.
3. **Given** existing agents created under default M, **When** the operator changes the default to M2, **Then** existing agents still use M (or their explicit choice) and only subsequently created agents inherit M2.
4. **Given** a fleet default was set, **When** the app is restarted, **Then** the same fleet default is still in effect.
5. **Given** the fleet-default setting surface is open, **When** the operator sets or changes the default, **Then** the surface states that the change applies only to agents created afterward and does not retroactively change existing agents (FR-014).

### User Story 3 - Change an existing agent's assignment per desk (Priority: P1)

The operator changes the provider+model of an existing desk after it was created — e.g., moving a desk from Claude to DeepSeek. The new assignment is recorded and persists; the change shows clearly whether the desk now uses an explicit model or has reverted to the fleet default.

**Why this priority**: Required MVP acceptance criterion ("change it per desk") — operators need to retune cost/capability per desk over time, not only at creation.

**Independent Test**: Open an existing agent, change its model to a different provider's model, confirm the new model is recorded, persists across restart, and that a "revert to fleet default" action returns the desk to inheriting the default.

**Acceptance Scenarios**:

1. **Given** an existing agent assigned model M, **When** the operator changes it to model M2, **Then** the agent's assignment becomes M2 (source = explicit) and persists across restart.
2. **Given** an agent with an explicit assignment, **When** the operator chooses "revert to fleet default", **Then** the agent's assignment becomes inherited and tracks the current fleet default.
3. **Given** an agent showing its assignment, **When** the operator views it, **Then** the UI distinguishes "using fleet default (M)" from "custom: M2".

### User Story 4 - Capability-aware warning at assignment (Priority: P1)

When the operator assigns a model that lacks one or more capabilities (images, MCP tools, web search, caching), the assignment surface shows a clear, non-blocking warning naming the unsupported capabilities so the operator can decide knowingly. The warning never prevents the assignment.

**Why this priority**: Required MVP acceptance criterion and the assignment-time half of ADR-0008 — it is the guardrail that keeps "degrade gracefully, never silently break" honest at the moment of choice; without it the operator discovers capability gaps only after work fails.

**Independent Test**: Assign a model whose capability descriptor lacks a capability and confirm a warning naming that capability appears while the Save/confirm action stays enabled; assign a fully capable model and confirm no warning appears.

**Acceptance Scenarios**:

1. **Given** model M's descriptor reports an unsupported capability, **When** the operator selects M in the assignment surface, **Then** a non-blocking warning naming each unsupported capability is shown and the assignment action remains enabled.
2. **Given** model M supports all capabilities, **When** the operator selects M, **Then** no capability warning is shown.
3. **Given** a warning is shown, **When** the operator proceeds, **Then** the assignment is recorded normally (the warning does not block or alter the choice).

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST present, in the Add-Agent drawer, a provider+model picker whose options are read from the E002 registry, grouped by provider, showing each model's provider and capability tags.
- **FR-002**: System MUST allow the operator to select a specific provider+model for an agent at creation time and record that selection as the agent's explicit assignment (the resulting model binding and precedence are governed by FR-008).
- **FR-003**: System MUST allow the operator to change an existing agent's provider+model assignment after creation, per desk.
- **FR-004**: System MUST allow the operator to revert an agent to inheriting the fleet default, and MUST visibly distinguish an explicitly-assigned desk from one inheriting the fleet default.
- **FR-005**: System MUST allow the operator to set and change a fleet-default provider+model.
- **FR-006**: System MUST apply the fleet default to newly created agents that do not specify their own provider+model, and MUST NOT retroactively change the assignment of agents that already exist when the default changes.
- **FR-007**: System MUST persist per-agent assignments and the fleet default durably and restore them after an application restart.
- **FR-008**: System MUST make the assigned model the model the agent is created with, preserving the existing precedence (explicit assignment → fleet default → role-based fallback) and recording the provider (derivable from the model via the registry) for downstream consumers.
- **FR-009**: System MUST display a clear, non-blocking warning at assignment time naming each capability the chosen model lacks (images, MCP tools, web search, caching), and MUST allow the assignment to proceed regardless.
- **FR-010**: System MUST indicate in the picker when a model's provider has no stored credential (using E004 presence), without blocking selection of that model.
- **FR-011**: System MUST handle an assignment whose model is no longer in the registry by preserving the stored assignment, marking it stale, and prompting re-selection — without silently remapping it to another provider or model.
- **FR-012**: System MUST present a clear empty-state in the picker when no providers/models are available, and MUST fall back to existing default agent-creation behavior in that case.
- **FR-013**: System MUST expose the same assignment mechanism to the GOD agent so it can assign a provider+model to an agent programmatically, subject to the same persistence and warning behavior.
- **FR-014**: The fleet-default setting surface MUST state its scope to the operator — that changing the default applies to agents created afterward only and does not retroactively change existing agents (FR-006) — so the non-retroactive behavior is legible at the point of change.

### Key Entities *(include for product or technical specs if feature involves data)*

- **AgentAssignment**: the binding of an agent (desk) to a chosen model, with the provider derived from that model via the registry. Attributes: target agent, chosen model id, derived provider id, and source (`explicit` when the operator/GOD chose it, `fleet-default` when inherited). One per agent; absent for agents using the role-based fallback.
- **FleetDefault**: the house-wide default model (provider derived from the model) applied to newly created agents that have no explicit assignment. Single value, persisted in harness config; absence means the role-based fallback applies.
- **CapabilityDescriptor** *(owned by E002; referenced read-only)*: the per-model capability flags (`supportsImages`, `supportsMcpTools`, `supportsWebSearch`, `supportsCaching`) that the assignment warning reads to compute and name a chosen model's gaps.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The E002 provider/model registry is frozen/stable for this epic and exposes, per model, a provider id and a capability descriptor (the four capability flags) that assignment reads read-only.
- A model id uniquely determines its provider via the registry, so an assignment can store the model and derive the provider rather than maintaining two independently-editable fields.
- The capability warning is gap-based: it names the capabilities the chosen model lacks; the operator judges whether their work needs them. No separate per-agent "needed capabilities" declaration is introduced in this epic.
- E004 credential presence (which providers have a key) is readable by the renderer to annotate the picker; running a desk without a key is a downstream (E006/runtime) concern, not an assignment blocker.
- The fleet default and per-agent assignment reuse the existing persistence substrate (harness config for the default; the persisted agent record for per-agent), extended to be registry-aware.

### Risks

- **Shared Add-Agent drawer / config schema with E004** *(likelihood: medium, impact: medium)*: concurrent edits to the same surfaces could clash; mitigate by keeping assignment fields additive and independently keyed from credential fields, and sequencing the work after E004 (already complete).
- **"Needed capability" is not knowable at assignment time** *(likelihood: medium, impact: low)*: the work an agent will do isn't fully known when assigning; mitigated by the gap-based warning that names what the chosen model lacks rather than predicting need.
- **Stale assignment after a registry change** *(likelihood: low, impact: medium)*: a model removed post-assignment could orphan a desk; mitigated by preserving the id, flagging it unavailable, and prompting re-selection instead of silent remapping (which would break parity and cost attribution).

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — AgentAssignment (per-agent model + derived provider + source) and a FleetDefault value; one assignment per desk, plus a single house default.
- `NEW-CONFIG` — harness config gains a fleet-default provider/model and the substrate to persist per-agent assignments across restart, coexisting additively with E004's `providerKeys`.
- `NEW-UI` — provider-grouped model picker in the Add-Agent drawer, a per-desk change/revert affordance with default-vs-custom provenance, a fleet-default setting surface, the capability-gap warning, credential-presence annotation, and empty/stale states.
- `BREAKING-CHANGE` — the renderer-facing agent record and config shape extend with assignment fields; consumers (E006, E010) read the new AgentAssignment. (Additive; no removal of existing fields.)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An operator can assign a specific provider+model to a new agent from the registry-backed picker, and the created agent is created with (bound to) exactly that model.
- **SC-002** [US1]: A per-agent explicit assignment is still associated with its agent after an application restart (100% of assignments survive restart).
- **SC-003** [US2]: With a fleet default set, a newly created agent that chooses no model inherits the default; with no default and no choice, it uses the existing role-based fallback.
- **SC-004** [US2]: Changing the fleet default leaves every pre-existing agent's assignment unchanged and applies only to agents created after the change.
- **SC-005** [US2]: The fleet default persists across an application restart.
- **SC-006** [US3]: An operator can change an existing desk's provider+model and revert it to the fleet default, with the UI clearly showing default-vs-custom provenance, and the change persists across restart.
- **SC-007** [US4]: Assigning a model that lacks a capability shows a warning naming each unsupported capability while keeping the assignment action enabled; assigning a fully capable model shows no warning.
- **SC-008** [US1]: When no providers/models are available, the picker shows an empty-state and agent creation still succeeds via the existing default behavior; when an assigned model is later missing from the registry, the assignment is flagged stale and prompts re-selection rather than switching providers.
- **SC-009** [US3]: The GOD agent can assign a provider+model to an agent programmatically through the same mechanism the operator uses, and the assignment persists and surfaces the same capability-gap warning behavior.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Desk | A single agent's seat on the office floor; "per desk" means per individual agent. |
| Assignment | The recorded binding of a desk to a chosen model (provider derived from the model via the registry). |
| Fleet default | The house-wide default model applied to newly created agents that have no explicit assignment. |
| Explicit vs inherited | An assignment chosen directly by the operator/GOD (`explicit`) versus one tracking the fleet default (`fleet-default`/inherited). |
| Capability descriptor | The per-model flags (images, MCP tools, web search, caching) from the E002 registry that the assignment warning reads. |
| Warn-at-assignment | A non-blocking notice at selection time naming capabilities the chosen model lacks; the assignment still proceeds. |
| GOD agent | The orchestrating agent that can assign provider/model to other agents programmatically through the same mechanism the operator uses. |

## Compliance Check

**Status**: PASS (Policy Auditor, 2026-06-08)

Audited against `project-instructions.md` (core principles I–V), governance rules in AGENTS.md / `.github/sddp-config.md`, and the cited sources. No violations.

- **I. Provider-Agnostic Parity** — PASS. Model is a per-desk/per-fleet setting, not a fork; provider derived from the model via the E002 registry; capability gaps surfaced uniformly (FR-009).
- **II. Truthful Cost Governance** — PASS. Read-only registry consumer; FR-011 forbids silent remapping of a stale model to another provider, protecting cost attribution.
- **III. Crash-Contained Isolation & Resilience** — N/A. Assignment-record epic; runtime/execution explicitly excluded.
- **IV. Agent Output Style** — PASS. Required sections present; stories within budget.
- **V. Preserve Proven Core & Type Safety** — PASS. `BREAKING-CHANGE` is additive; preserves existing explicit→default→role-based precedence (FR-008); no `/src` layout violation.
- **Degrade gracefully, never silently break** — PASS. Warn-at-assignment non-blocking (FR-009); empty-registry fallback (FR-012); stale model preserved and flagged (FR-011).
- **Registry as single source of truth** — PASS. Picker options read from E002; provider derived from model id; registry editing excluded.
- **No secrets in git/transcripts/telemetry** — PASS. Reads credential presence only (FR-010); never reads/stores/logs key material.
- **Governance out-of-scope guardrails** — PASS. Correctly excludes CAP-019 live switch parity, runtime degradation/execution, and registry/credential management.

Cross-references verified: epic sources `{PRD:CAP-013,CAP-018}{SAD:ADR-0008}`, dependencies (E001/E002 up; E006/E010 down), and the capability flags all match the project plan, PRD/SAD, and `src/shared/providerRuntime.ts`.
