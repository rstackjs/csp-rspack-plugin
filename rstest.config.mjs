import { defineConfig } from '@rstest/core';

export default defineConfig({
  name: 'CspHtmlRspackPlugin',
  include: ['**/*.test.js'],
  exclude: ['**/node_modules/**'],
  clearMocks: true,
  globals: true,
  coverage: {
    provider: 'istanbul',
  },
});
