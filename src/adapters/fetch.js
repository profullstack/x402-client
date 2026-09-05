/**
 * A paying `fetch`, for anything that takes a fetch.
 *
 * Most of the JavaScript crawling world is a `fetch` under a different name:
 * the globals in Node, Bun, Deno and the browser; `undici.fetch`;
 * `node-fetch`; and every library with a `fetch` option — ky, ofetch,
 * openai's and Anthropic's SDKs, LangChain loaders, Crawlee's `sendRequest`.
 * Wrap the one you have and hand the result to them.
 */

import { createClient } from '../client.js';

/**
 * A `fetch` that presents a filed pass and pays a 402 once.
 *
 * Same signature as the function it wraps. `options` are
 * {@link createClient}'s; pass `client` to share one wallet and pass file
 * across several wrapped fetches.
 *
 * @param {typeof fetch} fetchImpl  the fetch to make requests with
 * @param {import('../../index.d.ts').ClientOptions & { client?: import('../../index.d.ts').X402Client }} [options]
 * @returns {typeof fetch}
 */
export function wrapFetch(fetchImpl, options = {}) {
  const { client: given, ...rest } = options;
  // A shared client keeps its own fetch; the wrapped one is used only when
  // this wrapper is the client's whole reason to exist.
  const client = given ?? createClient({ ...rest, fetch: fetchImpl });
  const paying = given
    ? createClient({ ...rest, wallet: given.wallet, store: given.store, fetch: fetchImpl })
    : client;
  return (input, init) => paying.fetch(input, init);
}

/**
 * The global fetch, paying. `const fetch = x402Fetch({ key })`.
 *
 * @param {import('../../index.d.ts').ClientOptions} [options]
 * @returns {typeof fetch}
 */
export function x402Fetch(options = {}) {
  return wrapFetch(globalThis.fetch, options);
}
