import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const gate = { statements: 90, branches: 90, functions: 90, lines: 90 };

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': `${root}src`,
      // `server-only` throws outside the react-server condition; tests import server modules directly.
      'server-only': `${root}node_modules/server-only/empty.js`,
    },
  },
  test: {
    // Component tests opt in per file with `// @vitest-environment happy-dom`.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.next/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        'src/shared/types/**',
        'src/server/mock/**',
        'src/app/**',
        // data-only modules: nothing to execute
        'src/server/checks/types.ts',
        'src/server/checks/config.ts',
      ],
      reporter: ['text-summary', 'text'],
      thresholds: {
        'src/server/checks/**': gate,
        'src/server/accounting/**': gate,
      },
    },
  },
});
