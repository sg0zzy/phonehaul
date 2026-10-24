import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './integration-tests',
  testMatch: 'internet.browser.js',
  timeout: 60_000,
  workers: 1,
  outputDir: '/tmp/phonehaul-playwright-results',
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          executablePath: process.env.PHONEHAUL_CHROMIUM ?? '/usr/bin/chromium',
          args: ['--no-sandbox'],
        },
      },
    },
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        launchOptions: { firefoxUserPrefs: { 'media.peerconnection.ice.loopback': true } },
      },
    },
  ],
});
