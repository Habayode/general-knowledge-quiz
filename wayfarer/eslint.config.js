// Lint config: catches undefined references and dead code. Run: npx eslint .
const browser = Object.fromEntries(
  [
    'window',
    'document',
    'navigator',
    'location',
    'localStorage',
    'fetch',
    'URL',
    'URLSearchParams',
    'AbortController',
    'Intl',
    'performance',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setTimeout',
    'clearTimeout',
    'console',
    'confirm',
    'SpeechSynthesisUtterance',
    'maplibregl',
  ].map((g) => [g, 'readonly']),
);
const node = Object.fromEntries(
  ['process', 'Buffer', 'console', 'URL', 'fetch', 'setTimeout', 'Intl', 'performance'].map((g) => [g, 'readonly']),
);
const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'prefer-const': 'error',
  eqeqeq: ['error', 'smart'],
};
export default [
  { ignores: ['node_modules/**', 'tests/e2e/screenshots/**'] },
  { files: ['js/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browser }, rules },
  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...node, window: 'readonly', document: 'readonly', localStorage: 'readonly' },
    },
    rules,
  },
];
