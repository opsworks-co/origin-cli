import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // We only test pure utilities right now — no DOM-dependent component
    // tests yet. If/when we add those, switch to `environment: 'jsdom'`
    // and install jsdom + @testing-library/react.
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
