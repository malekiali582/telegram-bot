import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The admin panel. `npm run build` writes `dist/`, which the API serves on the same
 * origin. In development `npm run dev:panel` starts this with an /api proxy.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // The panel imports only types from @lulu/api; this keeps them pointing at sources.
    conditions: ['@lulu/source'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No inline scripts or data: URLs for modules, so the strict CSP holds.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
