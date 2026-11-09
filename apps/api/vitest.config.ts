import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    globalSetup: './tests/globalSetup.ts',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./test.db',
      DEV_MFA_HELPER: 'true',
      DEV_SHOW_RESET_TOKENS: 'true',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789-0123456789',
      REFRESH_TOKEN_PEPPER: 'test-refresh-pepper-0123456789',
      FIELD_ENCRYPTION_KEY: 'dGVzdC1maWVsZC1rZXktMzItYnl0ZXMtbG9uZy0hIQ==',
      APP_ORIGIN: 'http://localhost:4000',
      CORS_ORIGINS: 'http://localhost:5173',
    },
  },
});
