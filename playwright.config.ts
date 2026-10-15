import { defineConfig, devices } from '@playwright/test';

// Local (CI en PR):  E2E_LOCAL=1 -> siembra DynamoDB Local y levanta la API + UI en :3010.
// Live (post-deploy): E2E_BASE_URL=https://... npx playwright test --grep @smoke
const local = process.env.E2E_LOCAL === '1';
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3010';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.PW_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE } }
      : {}),
  },
  ...(local
    ? {
        webServer: {
          command: 'node scripts/e2e-serve.mjs',
          url: `${baseURL}/`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
      }
    : {}),
});
