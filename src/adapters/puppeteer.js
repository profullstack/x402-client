/**
 * Puppeteer, paying.
 *
 * Puppeteer's request interception can stop a request and change it, but it
 * cannot look at a response and then retry — so the 402 handshake lives at
 * the navigation instead. `gotoPaid` presents the filed pass, navigates,
 * and on a 402 pays from Node, presents the pass, and navigates once more.
 * `attachX402` makes `page.goto` do that, so an existing script pays with
 * one added line.
 *
 *   import puppeteer from 'puppeteer';
 *   import { attachX402 } from '@profullstack/x402-client/puppeteer';
 *   const page = await browser.newPage();
 *   attachX402(page, client);
 *   await page.goto('https://site/paid/page');
 *
 * Same against Lightpanda: `puppeteer.connect({ browserWSEndpoint })` and
 * everything below is unchanged. The key never enters the browser.
 *
 * `setExtraHTTPHeaders` is page-wide, so the pass goes out on every request
 * the page makes, cross-origin included. A pass is a bearer token for one
 * site and nothing else, and it expires; if the crawl leaves the site,
 * clear it with `page.setExtraHTTPHeaders({})` or use Playwright's routing.
 */

/**
 * Present the filed pass for a URL's site on every request the page makes.
 *
 * @param {{ setExtraHTTPHeaders: Function }} page
 * @param {string} url
 * @param {import('../../index.d.ts').X402Client} client
 * @returns {Promise<boolean>} whether there was one
 */
export async function applyPass(page, url, client) {
  const pass = client.passFor(url);
  if (!pass) return false;
  await page.setExtraHTTPHeaders({ [pass.header]: pass.token });
  return true;
}

/**
 * Navigate, paying a 402 once.
 *
 * @param {{ goto: Function, setExtraHTTPHeaders: Function }} page
 * @param {string} url
 * @param {import('../../index.d.ts').X402Client} client
 * @param {object} [options] forwarded to `page.goto`
 */
export async function gotoPaid(page, url, client, options) {
  await applyPass(page, url, client);
  let response = await page.goto(url, options);
  if (response && response.status() === 402) {
    const paid = await client.pay(url);
    if (paid.receipt.pass) {
      await applyPass(page, url, client);
      response = await page.goto(url, options);
    }
  }
  return response;
}

/**
 * Make `page.goto` pay. Returns a function that puts the original back.
 *
 * @param {{ goto: Function, setExtraHTTPHeaders: Function }} page
 * @param {import('../../index.d.ts').X402Client} client
 * @returns {() => void}
 */
export function attachX402(page, client) {
  const original = page.goto;
  const plain = { goto: original.bind(page), setExtraHTTPHeaders: page.setExtraHTTPHeaders.bind(page) };
  page.goto = (url, options) => gotoPaid(plain, String(url), client, options);
  return () => {
    page.goto = original;
  };
}
