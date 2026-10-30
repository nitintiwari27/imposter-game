import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'client',
  server: { host: '0.0.0.0', port: 5173, proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true } } },
  build: { outDir: '../dist', emptyOutDir: true },
});
