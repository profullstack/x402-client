/**
 * Playwright, paying.
 *
 * Playwright's routing can make the request itself, look at the answer, and
 * decide what the page sees — which is exactly the shape of a 402 handshake.
 * `attachX402` routes the page (or the whole context): every document, XHR
 * and fetch request goes out with the filed pass, a 402 is paid once and the
 * request made again with the pass, and the page receives the paid answer
 * as if the site had never asked. Other resources go through untouched but
 * for the pass header.
 *
 *   import { chromium } from 'playwright';
 *   import { attachX402 } from '@profullstack/x402-client/playwright';
 *   const page = await browser.newPage();
 *   await attachX402(page, client);
 *   await page.goto('https://site/paid/page');
 *
 * The browser never holds the key: the proof is signed and sent from Node
 * by the client, and only the pass reaches the browser. Works the same
 * against Lightpanda's CDP endpoint, since routing is Playwright's, not the
 * browser's.
 */

import { isOffer, parseOfferHeader } from '../x402.js';
import { acceptingJson } from './util.js';

const DEFAULT_TYPES = ['document', 'xhr', 'fetch'];

/**
 * @param {{ route: Function, unroute: Function }} target  a Page or a BrowserContext
 * @param {import('../../index.d.ts').X402Client} client
 * @param {{ pattern?: string|RegExp, resourceTypes?: string[] }} [options]
 * @returns {Promise<() => Promise<void>>} detach
 */
export async function attachX402(target, client, { pattern = '**/*', resourceTypes = DEFAULT_TYPES } = {}) {
  const types = new Set(resourceTypes);

  const handler = async (route, request) => {
    const url = request.url();
    const headers = { ...request.headers() };
    const filed = client.passFor(url);
    if (filed) headers[filed.header] = filed.token;

    if (!types.has(request.resourceType())) return route.continue({ headers });

    const first = await route.fetch({ headers });
    if (first.status() !== 402) return route.fulfill({ response: first });

    const text = await first.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    // A browser asks for text/html, and a gateway answers a browser's 402
    // with its sales page rather than the JSON offer. So the offer may not
    // be in what came back; if it is not, the client asks the URL again as
    // JSON and pays what that says. A 402 that is not x402 at all fails that
    // with `no-offer`, and the page sees the 402 the site sent.
    const offer = isOffer(json) ? json : parseOfferHeader(first.headers()['payment-required']);

    let paid;
    try {
      paid = await client.pay(url, {
        offer: offer ?? undefined,
        init: { method: request.method(), headers: acceptingJson(headers) },
      });
    } catch {
      // Not x402, refused, too expensive, no key: the page sees the 402.
      return route.fulfill({ response: first, body: text });
    }

    if (!paid.receipt.pass) {
      const body = typeof paid.body === 'string' ? paid.body : JSON.stringify(paid.body);
      return route.fulfill({
        status: paid.status,
        headers: { 'content-type': typeof paid.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' },
        body,
      });
    }

    headers[paid.receipt.header] = paid.receipt.pass;
    const again = await route.fetch({ headers });
    return route.fulfill({ response: again });
  };

  await target.route(pattern, handler);
  return async () => {
    await target.unroute(pattern, handler);
  };
}

/**
 * Navigate, paying a 402 once. For a script that would rather not route.
 *
 * Presents the filed pass through `setExtraHTTPHeaders` — which Playwright
 * sends on every request from the page, cross-origin included, so prefer
 * {@link attachX402} when the crawl leaves the site.
 *
 * @param {{ goto: Function, setExtraHTTPHeaders: Function }} page
 * @param {string} url
 * @param {import('../../index.d.ts').X402Client} client
 * @param {object} [options] forwarded to `page.goto`
 */
export async function gotoPaid(page, url, client, options) {
  const present = async () => {
    const pass = client.passFor(url);
    if (pass) await page.setExtraHTTPHeaders({ [pass.header]: pass.token });
    return Boolean(pass);
  };
  await present();
  let response = await page.goto(url, options);
  if (response && response.status() === 402) {
    const paid = await client.pay(url);
    if (paid.receipt.pass) {
      await present();
      response = await page.goto(url, options);
    }
  }
  return response;
}
