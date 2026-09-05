/**
 * Playwright through a paid site, paying as it goes.
 *
 *   npm i playwright @profullstack/x402-client
 *   X402_PRIVATE_KEY=0x… node examples/playwright.mjs https://site/page
 *
 * Works the same against Lightpanda: `chromium.connectOverCDP('ws://127.0.0.1:9222')`.
 */

import { chromium } from 'playwright';

import { createClient } from '@profullstack/x402-client';
import { attachX402 } from '@profullstack/x402-client/playwright';

const [url = 'https://rssamplifier.com/'] = process.argv.slice(2);

const client = createClient({
  key: process.env.X402_PRIVATE_KEY,
  store: 'file', // shared with the CLI and every other script on this machine
  maxUsd: 2,
  userAgent: 'MyAgent/1.0 (+https://example.test/bot)',
});

const browser = await chromium.launch();
const context = await browser.newContext();

// Route the whole context: every page it opens presents the pass, and a 402
// is paid from here — the browser never sees the key.
await attachX402(context, client);

const page = await context.newPage();
const response = await page.goto(url, { waitUntil: 'networkidle' });
console.log(`${response?.status()} ${url}`);
console.log((await page.content()).slice(0, 500));

await browser.close();
