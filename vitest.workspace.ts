import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/api',
  'apps/web',
  'packages/cli',
  'packages/mcp-server',
]);
