import { defineConfig, type UserConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { applyMacDevAppIdentity } from './electron.dev-bundle';

const config: UserConfig = {
  main: {
    // `null` in every build except electron.update-smoke.ts's throwaway
    // packages (src/main/updates/smoke-trust.ts); never read at runtime.
    define: {
      __INTERLEAF_UPDATE_SMOKE_TRUST__: JSON.stringify(process.env.INTERLEAF_UPDATE_SMOKE_TRUST ?? null),
    },
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.js',
      },
      rollupOptions: {
        output: {
          // Keep a single CJS chunk so `out/main/index.js` is the packaged entry.
          inlineDynamicImports: true,
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // Sandboxed preloads cannot resolve application dependencies at runtime.
      // Keep Electron external, but bundle every other dependency into the
      // standalone bridge script.
      externalizeDeps: false,
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.js',
      },
      rollupOptions: {
        external: ['electron'],
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // The isolated diagram renderer. A second entry rather than a chunk
          // of the reader: it is loaded into its own window, so its script and
          // the Mermaid chunks it splits into must exist as local assets the
          // application bundle carries offline.
          mermaidSandbox: resolve(__dirname, 'src/renderer/mermaid-sandbox/index.html'),
        },
      },
    },
    plugins: [react(), tailwindcss()],
    worker: {
      format: 'es',
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
  },
};

export default defineConfig(({ command }) => {
  // Development-only: gives an unpackaged macOS run the Interleaf app identity.
  applyMacDevAppIdentity(__dirname, command);
  return config;
});
