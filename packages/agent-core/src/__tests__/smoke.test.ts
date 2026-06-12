/** Phase 0 wiring smoke: importing the package by its bare specifier (not a relative
 *  path) proves the workspace + vitest alias resolves `@jsh562/agent-core` to source.
 *  As real modules migrate in, this grows into the package's own export sanity check. */
import { describe, it, expect } from 'vitest';
import { AGENT_CORE_PACKAGE } from '@jsh562/agent-core';

describe('@jsh562/agent-core package wiring', () => {
  it('resolves via the workspace/bundler alias', () => {
    expect(AGENT_CORE_PACKAGE).toBe('@jsh562/agent-core');
  });
});
