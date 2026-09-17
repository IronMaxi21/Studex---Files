/**
 * Browser tests for the desktop interface.
 *
 * The unit tests cover the API and the web layer is checked only for parsing,
 * which leaves the part a student actually touches — a deck made, a card
 * reviewed, a PDF marked up, a notebook imported — proven by nothing. These
 * four journeys are that proof.
 *
 * One worker, and the tests share a database: they run against one server with
 * one account, in file order, because parallel workers signing into the same
 * library would be testing each other rather than the app.
 */
import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/account.js';

const PORT = 8123;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Generous, because the first test in a file waits for a cold server, and
  // parsimony here only ever shows up as a flake on a loaded machine.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: BASE_URL,
    // Nothing here is worth keeping for a test that passed.
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    // Signing up is a test, and it is also the only way to get a session, so
    // it runs first and hands its cookies to everything else.
    { name: 'setup', testMatch: /auth\.setup\.ts$/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
    },
  ],
  webServer: {
    command: 'node --import tsx e2e/server.ts',
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
