import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Set WEB_PORT to use another port, and add that origin to CORS_ORIGINS
    // in apps/api/.env. strictPort keeps Vite from silently moving to 5174,
    // which the API would then reject as a foreign origin.
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
