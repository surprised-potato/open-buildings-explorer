import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

function inputSwitchPolyfillCssPlugin(): Plugin {
  return {
    name: 'input-switch-polyfill-css',
    generateBundle() {
      const cssPath = path.resolve(
        __dirname,
        'node_modules/input-switch-polyfill/input-switch-polyfill.css'
      );
      if (fs.existsSync(cssPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'assets/input-switch-polyfill.css',
          source: fs.readFileSync(cssPath, 'utf-8'),
        });
      }
    },
  };
}

export default defineConfig({
  // GitHub Pages serves from /<repo>/; the deploy workflow sets VITE_BASE.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), inputSwitchPolyfillCssPlugin()],
  optimizeDeps: {
    exclude: ['input-switch-polyfill'],
  },
  build: {
    target: 'esnext',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
