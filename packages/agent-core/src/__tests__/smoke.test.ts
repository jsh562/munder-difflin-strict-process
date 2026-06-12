/** Phase 0 wiring smoke: importing the package by its bare specifier (not a relative
 *  path) proves the workspace + vitest alias resolves `@munder/agent-core` to source.
 *  As real modules migrate in, this grows into the package's own export sanity check. */
import { describe, it, expect } from 'vitest';
import { AGENT_CORE_PACKAGE } from '@munder/agent-core';

describe('@munder/agent-core package wiring', () => {
  it('resolves via the workspace/bundler alias', () => {
    expect(AGENT_CORE_PACKAGE).toBe('@munder/agent-core');
  });
});
