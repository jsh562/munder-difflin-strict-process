// Flat ESLint config (ESLint 10 + typescript-eslint). Lints the app source under
// /src. Pragmatic ruleset for an existing prototype: recommended correctness
// rules as errors; stylistic/strictness noise that the never-linted existing
// codebase trips is relaxed to warnings or off so the gate is meaningful without
// a mass rewrite. Tighten incrementally (the TODO(LINTER) ratchet).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      '**/dist/**',
      '.test-build/**',
      'docs/**',
      'landing-remotion/**',
      'tools/**',
      '**/*.cjs'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Existing pragmatic patterns in the v0.2.x codebase — surface, don't block.
      'no-useless-assignment': 'warn',
      // Terminal/ANSI parsing intentionally matches control chars (e.g. \x1b).
      'no-control-regex': 'off'
    }
  },
  {
    // The renderer already annotates hooks deps; register the plugin so those
    // directives resolve. Kept as warnings (incremental adoption).
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // Architecture boundary (extraction guard): @jsh562/won-agent-core must stay
    // host-agnostic — no electron, no node-pty, and NO import back into the host app
    // (src/**). It MAY use Node builtins (it's a Node library: fs/child_process/etc.).
    // This is the static counterpart to the runtime boundary.test.ts guard; together
    // they keep the package independently publishable.
    files: ['packages/won-agent-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'electron', message: 'won-agent-core must stay host-agnostic — no electron.' },
          { name: 'node-pty', message: 'won-agent-core must stay host-agnostic — no node-pty.' }
        ],
        patterns: [
          { group: ['electron/*'], message: 'won-agent-core must stay host-agnostic — no electron.' },
          { group: ['**/src/main/**', '**/src/renderer/**', '**/src/preload/**', '**/src/shared/**'], message: 'won-agent-core must not import the host app (src/**) — invert the dependency via an injected seam.' }
        ]
      }]
    }
  }
);
