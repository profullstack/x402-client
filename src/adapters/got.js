/**
 * got, paying.
 *
 * got's hooks are the right shape for this: `beforeRequest` presents the
 * filed pass, `afterResponse` sees the 402, pays it, and asks got to retry
 * the same request with the pass merged in. Spread the result into
 * `got.extend()` and the crawler pays as it goes.
 *
 *   import got from 'got';
 *   import { x402Hooks } from '@profullstack/x402-client/got';
 *   const paying = got.extend(x402Hooks(client));
 *
 * Crawlee's `got-scraping` is got underneath and takes the same hooks.
 */

import { isOffer, parseOfferHeader } from '../x402.js';
import { acceptingJson } from './util.js';

/**
 * @param {import('../../index.d.ts').X402Client} client
 * @returns {{ hooks: { beforeRequest: Function[], afterResponse: Function[] } }}
 */
export function x402Hooks(client) {
  return {
    hooks: {
      beforeRequest: [
        (options) => {
          const url = hrefOf(options.url);
          if (!url) return;
          const pass = client.passFor(url);
          if (pass) options.headers[pass.header] = pass.token;
        },
      ],
      afterResponse: [
        async (response, retryWithMergedOptions) => {
          if (response.statusCode !== 402) return response;
          const options = response.request?.options;
          if (options?.context?.x402Paid) return response;

          const url = response.url ?? hrefOf(options?.url);
          if (!url) return response;

          let json = null;
          try {
            json = JSON.parse(String(response.body ?? ''));
          } catch {
            json = null;
          }
          // The offer is in the 402 when the request asked for JSON. A scraper
          // wearing a browser's Accept header gets the HTML sales page, so
          // when there is no offer here the client asks the URL again as
          // JSON. A 402 that is not x402 fails that with `no-offer`, and the
          // 402 is returned as it came.
          const offer = isOffer(json) ? json : parseOfferHeader(response.headers?.['payment-required']);

          let paid;
          try {
            paid = await client.pay(url, {
              offer: offer ?? undefined,
              init: { method: options?.method ?? 'GET', headers: acceptingJson(options?.headers) },
            });
          } catch (err) {
            if (err?.code === 'no-offer') return response;
            throw err;
          }

          if (!paid.receipt.pass) {
            // A plain x402 resource: the paid answer is the resource.
            response.statusCode = paid.status;
            response.body = typeof paid.body === 'string' ? paid.body : JSON.stringify(paid.body);
            return response;
          }

          return retryWithMergedOptions({
            headers: { [paid.receipt.header]: paid.receipt.pass },
            context: { ...(options?.context ?? {}), x402Paid: true },
          });
        },
      ],
    },
  };
}

function hrefOf(url) {
  if (!url) return null;
  if (typeof url === 'string') return url;
  return url.href ?? String(url);
}
