import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5176,
    proxy: {
      '/api': 'http://localhost:4002',
    },
  },
  build: {
    // Split common vendor deps into their own chunks so page changes don't
    // invalidate the whole cached JS blob and first-paint isn't blocked on a
    // 2MB download. Keeps the warning quiet and improves repeat-visit speed.
    chunkSizeWarningLimit: 1_200,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'chart-vendor': ['recharts'],
        },
      },
    },
  },
})
