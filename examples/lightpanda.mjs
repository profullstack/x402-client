/**
 * Lightpanda through a paid site.
 *
 * Lightpanda has no plugin system, and does not need one here: a gateway that
 * sells crawl time hands back a pass after one payment, and the browser only
 * has to present it. From the shell that is one flag:
 *
 *   lightpanda fetch --http-header "x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
 *
 * From a script, connect Puppeteer to `lightpanda serve` and let the adapter
 * make `page.goto` pay. Nothing below is Lightpanda-specific; it is the same
 * against Chrome.
 *
 *   npm i puppeteer-core @profullstack/x402-client
 *   lightpanda serve --host 127.0.0.1 --port 9222 &
 *   X402_PRIVATE_KEY=0x… node examples/lightpanda.mjs https://site/page
 */

import puppeteer from 'puppeteer-core';

import { createClient } from '@profullstack/x402-client';
import { attachX402 } from '@profullstack/x402-client/puppeteer';

const [url = 'https://rssamplifier.com/'] = process.argv.slice(2);

const client = createClient({
  key: process.env.X402_PRIVATE_KEY,
  store: 'file', // ~/.config/x402-client/passes.json, shared with the CLI
  maxUsd: 2,
  userAgent: 'MyAgent/1.0 (+https://example.test/bot)',
});

const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9222' });
const page = await browser.newPage();

// page.goto now presents the filed pass, and on a 402 pays from Node, files
// the pass, and navigates again. The browser never holds the key.
attachX402(page, client);

const response = await page.goto(url, { waitUntil: 'networkidle0' });
console.log(`${response?.status()} ${url}`);
console.log((await page.content()).slice(0, 500));

await browser.disconnect();
