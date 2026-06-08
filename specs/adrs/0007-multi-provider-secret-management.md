---
adr_id: ADR-0007
status: accepted
date: 2026-06-07
tags: [multi-provider, security, secrets]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0007: Multi-provider secret management — plaintext config for the MVP

## Status

Accepted.

## Context

Native multi-provider support requires storing several providers' API keys (Claude, DeepSeek, Minimax). The harness previously assumed a single logged-in Claude session, so it had no mechanism for persisting multiple distinct provider credentials. Options range from OS-keychain encryption (Electron `safeStorage`) to plaintext config. The project owner explicitly chose the simplest path for the MVP, accepting the security tradeoff, with hardening deferred.

## Decision Drivers

- Time-to-MVP simplicity and portability.
- Avoiding platform-specific keychain edge cases (notably the Linux libsecret-absent fallback).
- (Consciously deprioritized for the MVP) At-rest key protection.

## Considered Options

### Option A: Plaintext API keys in the harness config file

- **Pros**: Simplest possible implementation; no keychain edge cases; portable across machines.
- **Cons**: INSECURE AT REST — keys are readable by any local process or user with file access; must be excluded from the git hive, transcripts, and OTel output.

### Option B: Electron `safeStorage` (OS keychain) with ciphertext in SQLite

- **Pros**: OS-grade protection (macOS Keychain / Windows DPAPI / Linux libsecret); reuses the existing `db.ts` SQLite store.
- **Cons**: Linux silently falls back to plaintext when no keyring is present (must detect and warn); ciphertext is machine/user-bound and therefore not portable.

### Option C: Encrypted SQLite with a user passphrase

- **Pros**: Portable; not machine-bound.
- **Cons**: Passphrase-prompt UX on each launch; only as strong as the passphrase.

## Decision Outcome

Chosen option: **Option A (plaintext API keys in the harness config file)** — selected for the MVP because it is the simplest, most portable approach and avoids all cross-platform keychain failure modes. Keys are injected into the agent worker at spawn and MUST never be written to the git hive, transcripts, or OTel output; the config file must live outside any registered repo and be gitignored. Hardening to Option B (`safeStorage` over the OS keychain) is the recommended deferred follow-up and is recorded as an open question in the SAD.

## Consequences

### Positive

- Simplest possible implementation.
- Portable across machines.
- No cross-platform keychain failure modes to handle now.

### Negative

- Provider API keys are stored unencrypted at rest — an explicit, accepted residual security risk for the MVP.
- Anyone with read access to the config file obtains live billable credentials.

### Neutral

- A later migration to `safeStorage` (Option B) is non-breaking, since it reuses the same key-injection seam.

## Links

- PRD CAP-014.
- SAD Risks (plaintext-key exposure) and Open Questions (keychain hardening).
- Related ADR-0003 (key injected to worker at spawn).
