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
    // Pre-transform the entry points + the hottest pages on dev-server boot
    // so the first navigation is fast instead of triggering a transform storm.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/DeveloperLayout.tsx',
        './src/components/Layout.tsx',
        './src/pages/MyDashboard/index.tsx',
        './src/pages/Sessions.tsx',
        './src/pages/SessionDetail.tsx',
        './src/pages/Repos.tsx',
      ],
    },
  },
  // Pre-bundle heavy ESM deps once up front rather than on-demand when a
  // lazy-loaded page first imports them. With 170+ source files split
  // across lazy routes, cold-start dep optimization was the main source of
  // dev-server slowness.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      'react-helmet-async',
      'recharts',
      'lucide-react',
    ],
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
