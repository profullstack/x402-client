/**
 * The client: a `fetch` that pays.
 *
 * The shape of a paid request, as every x402 server does it:
 *
 *   1. ask for the resource; get 402 with an offer
 *   2. pick an option the wallet can sign, sign an EIP-3009 authorization
 *      for exactly that amount to exactly that address, and ask again with
 *      the proof in a header
 *   3. get the resource — or, from a gateway selling time rather than pages,
 *      a receipt naming a pass, which then opens every page for a day
 *
 * Step 3 is the reason this is a client and not a function: a pass is worth
 * remembering, and a crawler that forgets it pays for the same day on every
 * page. Passes are filed by origin and presented automatically.
 *
 * Two rules keep a key-holding client from being a footgun. It never pays
 * twice for one request: a second 402 after a proof means the payment was
 * refused, and signing another authorization for a server that just refused
 * one would be spending on a guess. And it never pays more than `maxUsd`,
 * which defaults low enough that a misconfigured server or a hostile one
 * cannot drain a wallet by asking.
 */

import { fileStore, memoryStore, originOf } from './passes.js';
import { walletFromKey } from './wallet.js';
import { amountUsd, readOffer, readReceipt, selectAccept, signPayment } from './x402.js';

/**
 * A failure with a name a program can switch on.
 *
 * `code` is one of `no-key` (nothing to sign with), `no-offer` (402 without
 * x402 in it), `no-option` (nothing signable in the offer), `too-expensive`
 * (over `maxUsd`, or unpriceable), `rejected` (the server refused the proof).
 */
export class X402Error extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, body?: any, offer?: object|null, url?: string }} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
    this.status = detail.status ?? null;
    this.body = detail.body ?? null;
    this.offer = detail.offer ?? null;
    this.url = detail.url ?? null;
  }
}

/** The default ceiling on one payment, in dollars. A day of crawling costs one. */
export const DEFAULT_MAX_USD = 5;

/**
 * @param {import('../index.d.ts').ClientOptions} [options]
 * @returns {import('../index.d.ts').X402Client}
 */
export function createClient(options = {}) {
  const {
    key,
    networks,
    maxUsd = DEFAULT_MAX_USD,
    validForSeconds,
    userAgent,
    fetch: f = globalThis.fetch,
  } = options;

  const wallet = options.wallet ?? (key ? walletFromKey(key) : null);
  const store = options.store === 'file' ? fileStore() : (options.store ?? memoryStore());

  const baseHeaders = (init) => {
    const headers = new Headers(init?.headers ?? {});
    if (userAgent && !headers.has('user-agent')) headers.set('user-agent', userAgent);
    return headers;
  };

  /** The live pass for a URL's origin, if one is filed. */
  const passFor = (url) => store.get(originOf(url));

  /**
   * Pay for a URL and file whatever pass comes back.
   *
   * With no `offer` given, the URL is asked first, as JSON, to get one. The
   * proof is sent on the same request the offer came from: a gateway wants it
   * on the page or on `/crawl`, a plain resource wants it on itself.
   */
  const pay = async (url, { offer: given, init = {} } = {}) => {
    const target = String(url instanceof Request ? url.url : url);
    if (!wallet) throw new X402Error('no-key', 'Nothing to pay with: create the client with a `key` or a `wallet`', { url: target });

    let offer = given ?? null;
    let body = null;
    if (!offer) {
      const headers = baseHeaders(init);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      const first = await f(target, { ...init, headers });
      if (first.status !== 402) {
        throw new X402Error('no-offer', `${target} answered ${first.status}, not 402; there is nothing to pay for`, {
          status: first.status,
          url: target,
        });
      }
      ({ offer, body } = await readOffer(first));
      if (!offer) {
        throw new X402Error('no-offer', `${target} answered 402 without an x402 offer`, { status: 402, body, url: target });
      }
    }

    const entry = selectAccept(offer.accepts, { networks });
    if (!entry) {
      const offered = (offer.accepts ?? []).map((a) => a?.network).filter(Boolean).join(', ') || 'nothing';
      throw new X402Error('no-option', `The offer has no option this wallet can sign (offered: ${offered})`, { offer, url: target });
    }

    const usd = amountUsd(entry);
    if (usd === null || usd > maxUsd) {
      const price = usd === null ? 'a token this client cannot price' : `$${usd.toFixed(2)}`;
      throw new X402Error('too-expensive', `Refusing to pay ${price} for ${target}; the ceiling is $${maxUsd} (maxUsd)`, {
        offer,
        url: target,
      });
    }

    const { header, authorization, payment } = signPayment(entry, wallet, { validForSeconds });

    const headers = baseHeaders(init);
    // CoinPay's dialect reads the v1 name; v2 facilitators read the other.
    // Sending both costs a few hundred bytes and works against either.
    headers.set('x-payment', header);
    headers.set('payment-signature', header);
    if (!headers.has('accept')) headers.set('accept', 'application/json');

    const paid = await f(target, { ...init, headers });
    const text = await paid.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (paid.status === 402) {
      const reason = json?.error ?? (text.slice(0, 200) || String(paid.status));
      throw new X402Error('rejected', `${target} refused the payment: ${reason}`, {
        status: 402,
        body: json ?? text,
        offer,
        url: target,
      });
    }

    const receipt = readReceipt(paid, json);
    if (receipt.pass) {
      store.set(originOf(target), {
        token: receipt.pass,
        header: receipt.header,
        expires: receipt.expires,
        boughtAt: new Date().toISOString(),
        url: target,
      });
    }

    return {
      status: paid.status,
      body: json ?? text,
      receipt,
      payer: wallet.address,
      network: entry.network,
      amount: authorization.value,
      amountUsd: usd,
      payTo: entry.payTo,
      nonce: authorization.nonce,
      payment,
    };
  };

  /**
   * `fetch`, paying once if asked to.
   *
   * A filed pass is presented on the way in. On a 402 the offer is paid, and
   * then: a pass means the original request is made again with it, since a
   * gateway's receipt is not the page; no pass means the paid response was
   * the resource and is returned as it came.
   */
  const paidFetch = async (input, init = {}, { pay: shouldPay = true } = {}) => {
    const target = String(input instanceof Request ? input.url : input);
    const headers = baseHeaders(init);

    const filed = passFor(target);
    if (filed) headers.set(filed.header, filed.token);

    const first = await f(target, { ...init, headers });
    if (first.status !== 402 || !shouldPay) return first;

    const { offer, body } = await readOffer(first);
    if (!offer) {
      // A 402 that is not x402 is the server's to explain, so hand it back
      // whole rather than as an exception about a protocol it does not speak.
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: 402,
        statusText: first.statusText,
        headers: first.headers,
      });
    }

    const result = await pay(target, { offer, init });
    if (!result.receipt.pass) {
      return new Response(typeof result.body === 'string' ? result.body : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': typeof result.body === 'string' ? 'text/plain' : 'application/json' },
      });
    }

    const again = baseHeaders(init);
    again.set(result.receipt.header, result.receipt.pass);
    return f(target, { ...init, headers: again });
  };

  return {
    get address() {
      return wallet?.address ?? null;
    },
    // The wallet signs and names itself and does nothing else; sharing it
    // between clients (one per fetch implementation, say) leaks no key.
    wallet,
    store,
    fetch: paidFetch,
    pay,
    passFor,
  };
}
