import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server on :3000. All /api requests are proxied to the FastAPI backend
// (default http://localhost:5000, override with VITE_BACKEND_URL in frontend/.env).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.VITE_BACKEND_URL || 'http://localhost:5000';

  return {
    plugins: [react()],
    // Exposed to the UI so the header can show which backend port the proxy targets.
    define: { __BACKEND_URL__: JSON.stringify(backend) },
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: true,
        },
      },
    },
    preview: { port: 3000 },
    build: {
      chunkSizeWarningLimit: 6000,
      rollupOptions: {
        output: {
          manualChunks: {
            monaco: ['monaco-editor'],
            pdf: ['jspdf'],
          },
        },
      },
    },
  };
});
