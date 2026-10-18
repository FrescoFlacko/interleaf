import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { externalNodeSqlite } from './tests/vitest/external-node-sqlite';
import { allowedFsRoots } from './tests/vitest/allowed-fs-roots';

export default defineConfig({
  plugins: [externalNodeSqlite],
  server: {
    fs: { allow: [...allowedFsRoots(__dirname)] },
  },
  test: {
    include: [
      'tests/unit/**/*.spec.ts',
      'tests/integration/**/*.spec.ts',
      'tests/renderer/**/*.spec.{ts,tsx}',
    ],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
});
