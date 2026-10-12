import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.NODECANVAS_BACKEND ?? 'http://127.0.0.1:8787'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Local only. `npm run dev:lan` overrides this to open the app to the local network.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Proxying keeps the browser same-origin; the backend still checks Origin and the CSRF header.
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        configure: (proxy) => {
          // The backend only trusts the local frontend origin. A browser on another device sends its
          // own address (http://<lan-ip>:5173) as Origin, so rewrite it, but ONLY when it equals the
          // address it is actually using (same-origin). A request from any other site keeps its Origin
          // and is rejected by the backend, so this does not open the API to cross-site requests.
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin
            if (origin && origin === `http://${req.headers.host}`) proxyReq.setHeader('origin', 'http://127.0.0.1:5173')
          })
        },
      },
    },
  },
})
