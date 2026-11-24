import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

const NEXT_PUBLIC_ENV = {
  selector: "MemberExpression[object.property.name='env'][property.name=/^NEXT_PUBLIC_/]",
  message: 'No NEXT_PUBLIC_* variables: every value stays server-side.',
};

// checks/ and accounting/ are pure: no I/O, no clock, no DB, no network (time comes in as `now`).
const PURE_MESSAGE = 'checks/ and accounting/ must stay pure: pass the clock in as `now` and take data as arguments.';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'coverage/**',
    'shots/**',
    'playwright-report/**',
    'test-results/**',
    'test/mock-upstreams/.run/**',
    'next-env.d.ts',
  ]),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', NEXT_PUBLIC_ENV],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/server/checks/**/*.ts', 'src/server/accounting/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'fs',
            'node:fs',
            'fs/promises',
            'node:fs/promises',
            'http',
            'node:http',
            'https',
            'node:https',
            'undici',
            'better-sqlite3',
          ].map((name) => ({ name, message: PURE_MESSAGE })),
          patterns: [
            { group: ['**/db', '**/db/**', '**/poller/**', '**/freqtrade/**', '**/kraken/**'], message: PURE_MESSAGE },
          ],
        },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: PURE_MESSAGE }],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: PURE_MESSAGE },
        { object: 'performance', property: 'now', message: PURE_MESSAGE },
      ],
      'no-restricted-syntax': [
        'error',
        NEXT_PUBLIC_ENV,
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: PURE_MESSAGE },
      ],
    },
  },
  {
    files: ['scripts/**', 'test/**', 'e2e/**', '*.config.*'],
    rules: { 'no-console': 'off' },
  },
]);
