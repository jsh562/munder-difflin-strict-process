# Research: Model and Provider Assignment

Product-spec research for per-agent and fleet-default provider/model selection with capability-aware warnings in a local Electron multi-agent harness. Options come from the E002 provider/model registry (with capability descriptors); assignments persist across restart.

## 1. Default + per-item override selection UX

Inheritance model: the fleet default sets a baseline; each agent either inherits or holds an explicit override. Operators must always see which value is default-set vs locally overridden, with an obvious "revert to default" action. Changing the default propagates only to inheriting items — never silently mutate explicit overrides.

Recommended: show each agent's effective model plus a badge distinguishing "Using fleet default (Model X)" from "Custom: Model Y"; one-click reset to default; state plainly that a default change applies to new agents (and inheritors) only.

Avoid: hiding provenance; retroactive default changes overwriting explicit per-agent choices; no revert path.

Sources: drbethmeyer "conveying inheritance in settings"; GitLab issue 213999 (inherit/override field UI).

## 2. Capability-gating / warn-don't-block UX

Warnings alert without obstructing; validations block. Warn for likely-but-not-certain problems (a capability mismatch the operator may knowingly accept); block only hard, false-negative-free rules (e.g., no model selected). Degrade-and-warn lets the action proceed while surfacing the risk inline.

Recommended: at assignment, show a non-modal inline warning naming the missing capability ("Model lacks images; this desk may handle image tasks"), but keep Save enabled. Reserve hard blocks for impossible states.

Avoid: blocking a valid assignment over a soft gap; burying the warning in a disappearing toast; over-strict validators that lock out intentional choices.

Sources: Baymard "validations vs warnings".

## 3. Provider/model picker UX in operator tools

Group models under their provider for scanability. Distinguish available vs uncredentialed/unavailable models — show unavailable ones visibly disabled with a reason so the operator isn't surprised by call-time failures. Provide a clear empty-state when no providers are configured that routes to setup.

Recommended: provider-grouped picker; mark models whose provider has no API key as disabled with inline reason ("No API key — add in Settings"); empty-state links to credential setup; surface capability tags per option.

Avoid: listing uncredentialed models as freely selectable with no signal; a blank picker with no guidance.

Sources: vscode-copilot-chat PR 1111 (provider-grouped BYOK picker); opencode.ai config docs (credentialed-provider gating).

## 4. Edge cases & failure modes

Treat the registry as a soft dependency — assignments must survive a model/provider going missing or uncredentialed. Persist by stable identifier and validate on load. Resolve a stale assignment (model removed post-assignment) gracefully: keep the stored id, flag it, prompt re-selection rather than crash or silently swap providers.

Recommended: (a) no API key on assigned provider → keep assignment, show "needs credentials," don't auto-switch; (b) model removed from registry → persist id, mark "unavailable/stale," prompt for a replacement, never default to another vendor (breaks parity + cost attribution); (c) persist assignments + fleet default to durable store, revalidate against the registry on startup; (d) fleet-default change must not mutate existing agents' explicit choices.

Avoid: silently remapping a stale/missing model to another provider; losing assignments on restart; a missing dependency crashing the harness.

Sources: AWS Well-Architected (graceful degradation, hard→soft dependency); DKAN issue 753 (stale-reference handling).

## Summary

Adopt an inheritance model: the fleet default seeds new agents; existing agents keep explicit overrides (never retroactively mutated). Always show provenance with a revert-to-default. Capability mismatches degrade-and-warn (non-modal, Save stays enabled), not block — block only impossible states. Persist assignments by stable id, validate against the registry on load, and handle missing-credential and removed-model cases as flagged, recoverable degraded states that prompt re-selection rather than silently re-mapping to another provider (which would break provider-agnostic parity and truthful cost attribution).
