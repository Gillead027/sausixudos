import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Precisa vir antes de '/api' — Vite casa por prefixo na ordem de
      // inserção, e só esta entrada tem ws:true pra fazer o upgrade de
      // WebSocket (a entrada genérica de /api abaixo é só HTTP comum).
      '/api/realtime': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/api': 'http://localhost:3000',
      '/livekit': {
        target: 'ws://localhost:7880',
        ws: true,
        rewrite: (path) => path.replace(/^\/livekit/, ''),
      },
    },
  },
});
