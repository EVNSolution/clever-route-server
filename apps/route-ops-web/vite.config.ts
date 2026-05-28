import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/ui/app/',
  build: {
    manifest: true,
    outDir: 'dist',
    sourcemap: true
  },
  plugins: [react()]
});
