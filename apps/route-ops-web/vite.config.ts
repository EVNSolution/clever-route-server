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
    rollupOptions: {
      // tracking.html is the public customer tracking page served by delivery-api at /t/:token.
      input: { main: 'index.html', tracking: 'tracking.html' }
    }
  },
  plugins: [react()]
});
