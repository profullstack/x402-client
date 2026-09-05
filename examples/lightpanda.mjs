/**
 * Lightpanda through a paid site.
 *
 * Lightpanda has no plugin system, and does not need one here: a gateway that
 * sells crawl time hands back a pass after one payment, and the browser only
 * has to present it. So the shape is
 *
 *   1. pay once, from Node, with this client
 *   2. give the pass to the browser as a header
 *
 * Two ways to do step 2. From the shell, with Lightpanda's own header flag:
 *
 *   lightpanda fetch --http-header "x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
 *
 * Or from Puppeteer, connected to `lightpanda serve` (or to Chrome — nothing
 * below is Lightpanda-specific), which is what this file does. The pass is
 * set once per page, and a 402 that still comes through is paid and the page
 * reloaded, once.
 *
 *   npm i puppeteer-core @profullstack/x402-client
 *   lightpanda serve --host 127.0.0.1 --port 9222 &
 *   X402_PRIVATE_KEY=0x… node examples/lightpanda.mjs https://site/page
 */

import puppeteer from 'puppeteer-core';

import { createClient } from '@profullstack/x402-client';

const [url = 'https://rssamplifier.com/'] = process.argv.slice(2);

const client = createClient({
  key: process.env.X402_PRIVATE_KEY,
  store: 'file', // ~/.config/x402-client/passes.json, shared with the CLI
  maxUsd: 2,
  userAgent: 'MyAgent/1.0 (+https://example.test/bot)',
});

const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9222' });
const page = await browser.newPage();

/** Present whatever pass is on file for the page's site. */
async function presentPass(target) {
  const pass = client.passFor(target);
  if (pass) await page.setExtraHTTPHeaders({ [pass.header]: pass.token });
  return Boolean(pass);
}

await presentPass(url);
let response = await page.goto(url, { waitUntil: 'networkidle0' });

if (response?.status() === 402) {
  // The browser was refused. Pay from Node — the browser never sees the key —
  // file the pass, hand it to the page, and go once more.
  const paid = await client.pay(url);
  console.error(`paid ${paid.amountUsd} USD on ${paid.network} from ${paid.payer}; pass good until ${paid.receipt.expires}`);
  await presentPass(url);
  response = await page.goto(url, { waitUntil: 'networkidle0' });
}

console.log(`${response?.status()} ${url}`);
console.log((await page.content()).slice(0, 500));

await browser.disconnect();
