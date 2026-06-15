import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/ui/app/',
  build: {
    // MapLibre is lazy-loaded by RouteOpsMap; keep warnings focused on
    // unexpected application bundle growth rather than the known map runtime.
    chunkSizeWarningLimit: 1100,
    manifest: true,
    outDir: 'dist',
    sourcemap: true
  },
  plugins: [react()]
});
