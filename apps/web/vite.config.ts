import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// Single source of truth for "what build is this." Used both to bake a
// constant into the JS bundle (BUILD_ID) and to write a build-info.json next
// to the dist root that the server serves. The client polls the JSON at
// runtime and compares it to the baked-in constant — when they diverge a
// new deploy has happened and the user's tab is on the old bundle.
const BUILD_ID = String(Date.now())

// Vite plugin: emit /build-info.json to dist after build. Tiny inline plugin
// instead of pulling in a copy plugin dep.
function emitBuildInfo() {
  return {
    name: 'origin-emit-build-info',
    apply: 'build' as const,
    closeBundle() {
      const out = path.resolve(__dirname, 'dist', 'build-info.json')
      fs.writeFileSync(out, JSON.stringify({ buildId: BUILD_ID }))
    },
  }
}

export default defineConfig({
  define: {
    // Baked-in identifier of the bundle the user is currently running.
    // Re-baked on every build, so two different deploys produce two
    // different constants.
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [react(), emitBuildInfo()],
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
