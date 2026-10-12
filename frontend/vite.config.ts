import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.NODECANVAS_BACKEND ?? 'http://127.0.0.1:8787'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Proxying keeps the browser same-origin; the backend still checks Origin and the CSRF header.
    proxy: { '/api': { target: backend, changeOrigin: true } },
  },
})
