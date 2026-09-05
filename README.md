# @profullstack/x402-client

Pay an [x402](https://x402.org) `402 Payment Required` from Node with a local key. Sign the EIP-3009 authorization, retry with the proof, keep the pass.

A crawler, an agent, or a script that meets a paid site needs three things: to read the offer, to sign it with a key it holds, and to remember what it bought so the next thousand requests are free. That is the whole package: a `fetch` that does all three, a CLI for shells, and the header that lets Lightpanda, Puppeteer or curl through a site sold by [@profullstack/x402-gateway](https://github.com/profullstack/x402-gateway) or any other x402 v2 server.

```
npm install @profullstack/x402-client
```

Two dependencies, `@noble/curves` and `@noble/hashes`, for one hash function and one signature. No ethers, no viem, no RPC: the payer never sends a transaction and never needs ETH. The facilitator broadcasts the authorization and pays the gas; the wallet holds USDC and signs.

## Fetch

```js
import { createClient } from '@profullstack/x402-client';

const client = createClient({ key: process.env.X402_PRIVATE_KEY });

const res = await client.fetch('https://rssamplifier.com/some/page');
// 402 → paid → the page. The pass is filed by origin, so:
const again = await client.fetch('https://rssamplifier.com/another/page');
// presents the pass, pays nothing.
```

`fetch` behaves like the global one until it sees a 402 carrying an x402 offer. Then it picks the first option it can sign, signs an EIP-3009 `TransferWithAuthorization` for exactly the offered amount to exactly the offered address, and asks again with the proof in `X-PAYMENT` and `PAYMENT-SIGNATURE`. A gateway answers with a receipt naming a pass, which is filed and presented on every later request to that origin; a plain x402 resource answers with the resource, which is returned as it came.

It pays once per request and never guesses: a second 402 after a proof means the payment was refused, and that is thrown as an `X402Error` with `code: 'rejected'` and the server's reason, not retried with a fresh signature.

## Pay, explicitly

```js
const result = await client.pay('https://rssamplifier.com/crawl');
result.payer;           // 0x… the address that signed
result.amountUsd;       // 1
result.network;         // 'eip155:8453'
result.receipt.pass;    // 'cp_…'   the day pass
result.receipt.header;  // 'x-crawl-pass'  where to put it
result.receipt.expires; // ISO timestamp
```

`pay` asks the URL for its offer (as JSON), signs, and files whatever pass comes back. Give it `{ offer }` to skip the first request when you already hold one.

## Options

```js
createClient({
  key,                    // 32-byte secp256k1 private key, hex. Or `wallet`.
  maxUsd: 5,              // refuse any single payment above this. Default 5.
  networks: ['eip155:8453'], // only pay on these chains, e.g. the one you funded
  store: 'file',          // file passes in ~/.config/x402-client/passes.json; default memory
  userAgent: 'MyBot/1.0 (+https://…)',
  validForSeconds,        // authorization lifetime; defaults to the offer's maxTimeoutSeconds
  fetch,                  // your own fetch, for proxies and tests
});
```

The ceiling is the one setting to think about. A client that holds a key and pays whatever it is asked is a client a hostile server can drain by asking. A day of crawling on a gateway costs a dollar; five is room for a dearer site and not for a mistake.

`networks` matters because the server's `accepts` is in its order of preference, and the first entry may be a chain your wallet has no USDC on. A signed authorization on an empty wallet verifies and then fails to settle, and the server answers 402 as if you had never paid.

## The CLI

```
npm install -g @profullstack/x402-client
export X402_PRIVATE_KEY=0x…

x402 address                       # fund this
x402 pay https://site/crawl        # receipt as JSON
x402 pass https://site/crawl       # the pass, buying one if none is on file
x402 fetch https://site/page       # the page, paying if it asks
x402 passes                        # what is on file
```

The key is read from the environment or `--key-file`, never from an argument. Passes are filed in `$XDG_CONFIG_HOME/x402-client/passes.json` with mode 0600, so one invocation buys and the rest present:

```
curl -H "x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
lightpanda fetch --http-header "x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
```

## Lightpanda and Puppeteer

Lightpanda has no plugin system, and does not need one: a gateway sells time, not pages, so the browser only has to carry the header a payment bought. The shell line above is the whole integration. For a script, [`examples/lightpanda.mjs`](examples/lightpanda.mjs) connects Puppeteer to `lightpanda serve`, presents the filed pass, and on a 402 pays from Node and reloads. The browser never holds the key. Nothing in it is Lightpanda-specific; it works against Chrome.

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

## License

MIT
