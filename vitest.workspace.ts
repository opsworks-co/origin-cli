import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/api',
  'packages/cli',
  'packages/mcp-server',
]);
