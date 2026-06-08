// Flat ESLint config (ESLint 9 + typescript-eslint). Lints the app source under
// /src. Pragmatic ruleset for an existing prototype: recommended correctness
// rules as errors; stylistic/strictness noise relaxed to warnings or off so the
// gate is meaningful without drowning the never-linted existing codebase.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
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
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  }
);
