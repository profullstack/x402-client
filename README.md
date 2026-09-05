# @profullstack/x402-client

[![npm](https://img.shields.io/npm/v/%40profullstack%2Fx402-client?logo=npm&label=npm)](https://www.npmjs.com/package/@profullstack/x402-client)
[![ci](https://github.com/profullstack/x402-client/actions/workflows/ci.yml/badge.svg)](https://github.com/profullstack/x402-client/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520.19-339933?logo=node.js&logoColor=white)](#runtimes)
[![bun](https://img.shields.io/badge/bun-tested-fbf0df?logo=bun&logoColor=black)](#runtimes)
[![deno](https://img.shields.io/badge/deno-tested-000000?logo=deno&logoColor=white)](#runtimes)
[![types](https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white)](index.d.ts)
[![license](https://img.shields.io/npm/l/%40profullstack%2Fx402-client)](LICENSE)

Pay an [x402](https://x402.org) `402 Payment Required` from JavaScript with a local key. Sign the EIP-3009 authorization, retry with the proof, keep the pass.

A crawler, an agent, or a script that meets a paid site needs three things: to read the offer, to sign it with a key it holds, and to remember what it bought so the next thousand requests are free. That is the whole package. It ships as a `fetch`, a CLI, and adapters that make the tools you already crawl with pay as they go.

| You crawl with | Add | Docs |
| --- | --- | --- |
| `fetch` — Node, Bun, Deno, browser, `undici`, `node-fetch`, `ky`, `ofetch` | `wrapFetch(fetch)` | [fetch](#fetch) |
| **axios** | `attachX402(axios, client)` | [axios](#axios) |
| **got**, `got-scraping`, **Crawlee** | `got.extend(x402Hooks(client))` | [got](#got-and-crawlee) |
| **Puppeteer**, `puppeteer-core`, Lightpanda over CDP | `attachX402(page, client)` | [Puppeteer](#puppeteer) |
| **Playwright** | `await attachX402(context, client)` | [Playwright](#playwright) |
| **curl**, wget, HTTPie, Lightpanda's CLI, anything with a header flag | `-H "x-crawl-pass: $(x402 pass URL)"` | [CLI](#the-cli) |

```
npm install @profullstack/x402-client     # node
bun add @profullstack/x402-client         # bun
deno add npm:@profullstack/x402-client    # deno
```

Two dependencies, `@noble/curves` and `@noble/hashes`, for one hash function and one signature. No ethers, no viem, no RPC: the payer never sends a transaction and never needs ETH. The facilitator broadcasts the authorization and pays the gas; the wallet holds USDC and signs.

## The client

```js
import { createClient } from '@profullstack/x402-client';

const client = createClient({ key: process.env.X402_PRIVATE_KEY });

const res = await client.fetch('https://rssamplifier.com/some/page');
// 402 → paid → the page. The pass is filed by origin, so:
const again = await client.fetch('https://rssamplifier.com/another/page');
// presents the pass, pays nothing.
```

`client.fetch` behaves like the global one until it sees a 402 carrying an x402 offer. Then it picks the first option it can sign, signs an EIP-3009 `TransferWithAuthorization` for exactly the offered amount to exactly the offered address, and asks again with the proof in `X-PAYMENT` and `PAYMENT-SIGNATURE`. A gateway answers with a receipt naming a pass, which is filed and presented on every later request to that origin; a plain x402 resource answers with the resource, which is returned as it came.

It pays once per request and never guesses: a second 402 after a proof means the payment was refused, and that is thrown as an `X402Error` with `code: 'rejected'` and the server's reason, not retried with a fresh signature.

```js
const result = await client.pay('https://rssamplifier.com/crawl');
result.payer;           // 0x… the address that signed
result.amountUsd;       // 1
result.network;         // 'eip155:8453'
result.receipt.pass;    // 'cp_…'   the day pass
result.receipt.header;  // 'x-crawl-pass'  where to put it
result.receipt.expires; // ISO timestamp

client.passFor(url);    // the live pass filed for that site, or null
```

### Options

```js
createClient({
  key,                       // 32-byte secp256k1 private key, hex. Or `wallet`.
  maxUsd: 5,                 // refuse any single payment above this. Default 5.
  networks: ['eip155:8453'], // only pay on these chains, e.g. the one you funded
  store: 'file',             // file passes in ~/.config/x402-client/passes.json; default memory
  userAgent: 'MyBot/1.0 (+https://…)',
  validForSeconds,           // authorization lifetime; defaults to the offer's maxTimeoutSeconds
  fetch,                     // your own fetch, for proxies and tests
});
```

The ceiling is the one setting to think about. A client that holds a key and pays whatever it is asked is a client a hostile server can drain by asking. A day of crawling on a gateway costs a dollar; five is room for a dearer site and not for a mistake. Buying a week at once is `?days=7` on the sales page and `maxUsd: 7`.

`networks` matters because the server's `accepts` is in its order of preference, and the first entry may be a chain your wallet has no USDC on. A signed authorization on an empty wallet verifies and then fails to settle, and the server answers 402 as if you had never paid.

## Adapters

Every adapter takes a client, presents the filed pass on the way out, pays a 402 once, and replays the request with the pass. None of them import the library they adapt: you pass in the instance you already have, and the package stays two dependencies. The axios and got adapters are tested against the real libraries; the browser adapters are tested against library-shaped fakes in CI and were verified by hand with real Puppeteer on Chrome and on Lightpanda, and real Playwright on Chrome, each loading a gated page with exactly one payment.

A gateway answers a browser's 402 with an HTML sales page rather than the JSON offer, since the browser asked for HTML. Every adapter handles that: when the 402 carries no offer, the client asks the URL again as JSON and pays what it says.

### fetch

```js
import { wrapFetch, x402Fetch } from '@profullstack/x402-client/fetch';

const fetch = x402Fetch({ key });                 // the global fetch, paying
const paying = wrapFetch(undici.fetch, { key });  // any fetch-shaped function

// Hand it to anything with a fetch option:
const api = ky.create({ fetch: paying });
const ai = new OpenAI({ fetch: paying });
```

Give several wrappers one `client` to share a wallet and a pass file:

```js
const client = createClient({ key, store: 'file' });
const a = wrapFetch(fetch, { client });
const b = wrapFetch(nodeFetch, { client });
```

### axios

```js
import axios from 'axios';
import { createClient } from '@profullstack/x402-client';
import { attachX402 } from '@profullstack/x402-client/axios';

const detach = attachX402(axios, createClient({ key }));   // or an axios.create()
const { data } = await axios.get('https://site/paid/page'); // paid once, then free
```

A request interceptor puts the pass on requests to sites that have one; a response interceptor catches the 402, pays, and replays with the pass. Works whether the 402 arrives as a rejection (axios' default) or as a response (a widened `validateStatus`). `baseURL` and relative URLs resolve as axios resolves them. The one request that carries the proof goes through the client's own fetch, not through axios, so an axios proxy does not apply to it.

### got and Crawlee

```js
import got from 'got';
import { x402Hooks } from '@profullstack/x402-client/got';

const paying = got.extend(x402Hooks(client));
const { body } = await paying('https://site/paid/page');
```

`beforeRequest` presents the pass, `afterResponse` pays a 402 and asks got to retry with the pass merged in. Crawlee's `got-scraping` is got underneath and takes the same hooks; for its browser crawlers, use the Playwright or Puppeteer adapter on the page in `preNavigationHooks`.

### Puppeteer

```js
import puppeteer from 'puppeteer';
import { attachX402 } from '@profullstack/x402-client/puppeteer';

const page = await browser.newPage();
attachX402(page, client);
await page.goto('https://site/paid/page');   // 402 → paid from Node → loaded
```

Puppeteer's interception cannot retry a response, so the handshake lives at the navigation: `page.goto` presents the filed pass, and on a 402 pays, presents, and navigates again. `gotoPaid(page, url, client)` is the same without patching, `applyPass(page, url, client)` just sets the header. Against Lightpanda, `puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9222' })` and nothing else changes; see [`examples/lightpanda.mjs`](examples/lightpanda.mjs). The pass is sent with `setExtraHTTPHeaders`, which is page-wide; it is a bearer token for one site and nothing else, and it expires, but clear it with `page.setExtraHTTPHeaders({})` if the crawl leaves the site.

### Playwright

```js
import { chromium } from 'playwright';
import { attachX402 } from '@profullstack/x402-client/playwright';

const context = await browser.newContext();
await attachX402(context, client);           // or a single page
const page = await context.newPage();
await page.goto('https://site/paid/page');   // the page sees the paid answer
```

Playwright's routing makes the request itself, so this is the cleanest of the adapters: every document, XHR and fetch request goes out with the pass, a 402 is paid and the request made again, and the page receives the paid answer as if the site had never asked. Other resources continue untouched but for the header. `resourceTypes` and `pattern` are options; `gotoPaid` exists for symmetry. The browser never holds the key. See [`examples/playwright.mjs`](examples/playwright.mjs).

### Lightpanda

No plugin system, and none needed: pay once from Node, hand the browser the header.

```
lightpanda fetch --http-header "x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
```

Or connect Puppeteer or Playwright to `lightpanda serve` and use the adapter above.

## The CLI

```
npm install -g @profullstack/x402-client          # or: npx / bunx / deno run -A npm:@profullstack/x402-client
export X402_PRIVATE_KEY=0x…

x402 address                       # fund this
x402 pay https://site/crawl        # receipt as JSON
x402 pay "https://site/crawl?days=7" --max-usd 7
x402 pass https://site/crawl       # the pass, buying one if none is on file
x402 fetch https://site/page       # the page, paying if it asks
x402 passes                        # what is on file
```

The key is read from the environment or `--key-file`, never from an argument. Passes are filed in `$XDG_CONFIG_HOME/x402-client/passes.json` with mode 0600, so one invocation buys and the rest present:

```
curl  -H "x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
wget  --header="x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
http  https://site/page "x-crawl-pass:$(x402 pass https://site/crawl)"
```

## Runtimes

Tested in CI on every push:

| runtime | how | status |
| --- | --- | --- |
| Node 22, 24 (works on 20.19+) | `node --test` | [![ci](https://github.com/profullstack/x402-client/actions/workflows/ci.yml/badge.svg)](https://github.com/profullstack/x402-client/actions/workflows/ci.yml) |
| Bun | `bun test`, `bun bin/x402.js` | same workflow |
| Deno 2 | `deno test -A`, `deno run -A bin/x402.js` | same workflow |

Nothing in the package is runtime-specific: base64 goes through `atob`/`btoa` and the text encoders rather than `Buffer`, randomness through `globalThis.crypto`, and the pass file through `node:fs`, which all three provide. The CLI is a plain script: `bunx @profullstack/x402-client pass URL` and `deno run -A npm:@profullstack/x402-client pass URL` both work.

## What is signed

x402's `exact` scheme on EVM is EIP-3009: the payer signs a `TransferWithAuthorization` under the **token's** EIP-712 domain, and whoever holds the signature can move exactly that amount to exactly that address, once, before `validBefore`. The signature is the payment. The client:

- takes the domain from the offer's `extra: { name, version }`, falling back to a table of USDC deployments read from the contracts, and refuses to sign a token whose domain it does not know, because a guessed domain recovers to the wrong address and fails with no diagnostic
- sets `validAfter` to 0 and bounds `validBefore` by the offer's own `maxTimeoutSeconds`, so no spendable authorization outlives the server's promise to settle
- uses a fresh random 32-byte nonce per payment
- emits `v` as 27/28, which is what `ecrecover` in `transferWithAuthorization` expects

The signer is a port of the one in CoinPay Wallet, which was checked byte for byte against ethers; the test suite holds this port to a digest and signature produced by that original.

## Errors

`X402Error` carries a `code`:

| code | meaning |
| --- | --- |
| `no-key` | the client has no key and was asked to pay |
| `no-offer` | the URL answered 402 with no x402 in it, or did not answer 402 |
| `no-option` | nothing in `accepts` is `exact` on an EVM chain in `networks` |
| `too-expensive` | over `maxUsd`, or a token this client cannot price |
| `rejected` | the server refused the proof; `body` has its reason |

## Selling, not buying?

[@profullstack/x402-gateway](https://github.com/profullstack/x402-gateway) is the other half: one middleware that answers training crawlers with a 402, sells passes by the day, and keeps search crawlers welcome.

## License

MIT
