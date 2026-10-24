import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'desktop/frontend-dist/**',
      'desktop/src-tauri/target/**',
      'desktop/src-tauri/gen/**',
      'receiver/.build/**',
    ],
  },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: [
      'desktop/frontend/src/**/*.js',
      'receiver/src/internet/web/**/*.js',
      'integration-tests/internet.browser.js',
    ],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];
