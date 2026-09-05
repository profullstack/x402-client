/**
 * x402 v2 on the wire, from the payer's side.
 *
 * Field shapes follow what servers actually emit, checked against
 * @profullstack/x402-gateway and CoinPay's `x402-v2` rather than remembered
 * from the spec: the 402 carries `{ x402Version: 2, accepts: [...] }` as its
 * JSON body (the gateway) or base64 in a `PAYMENT-REQUIRED` header (the
 * Coinbase-style facilitators), each `accepts` entry names a CAIP-2 network,
 * an `amount` in the token's smallest unit, the `asset` contract, `payTo`,
 * and the token's own EIP-712 domain in `extra`. The proof goes back as base64
 * JSON in `X-PAYMENT` (CoinPay's dialect, the v1 header name) and
 * `PAYMENT-SIGNATURE` (v2); both are sent, since a server reads one and
 * ignores the other.
 */

import { TRANSFER_WITH_AUTHORIZATION_TYPES } from './types.js';

export { TRANSFER_WITH_AUTHORIZATION_TYPES };

/** The protocol version the ecosystem is on. */
export const X402_VERSION = 2;

/**
 * EIP-712 domains for tokens a server might quote without saying so.
 *
 * A well-formed v2 entry carries `extra: { name, version }` and that is what
 * is used. This table is the fallback for an entry that omits it, because the
 * domain is not derivable: `version()` is not part of ERC-20. Every value was
 * read from the deployed contract over JSON-RPC by CoinPay; all three USDC
 * deployments answer "USD Coin" / "2".
 */
export const KNOWN_TOKEN_DOMAINS = {
  'eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USD Coin', version: '2', decimals: 6 },
  'eip155:137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { name: 'USD Coin', version: '2', decimals: 6 },
  'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USD Coin', version: '2', decimals: 6 },
};

/** Numeric EVM chain id from a CAIP-2 id, or null if it is not an eip155 chain. */
export function evmChainId(network) {
  const match = /^eip155:(\d+)$/i.exec(String(network ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * base64 (standard or url-safe) -> utf8, and back.
 *
 * On `atob`/`btoa` and the text encoders rather than `Buffer`, because the
 * four places this runs — Node, Bun, Deno and a browser — agree on those and
 * not on `Buffer`.
 */
function fromBase64(s) {
  const clean = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The offer carried in a `PAYMENT-REQUIRED` header, or null.
 *
 * Shared by the adapters, which each see a response in their own library's
 * shape and only have the raw header value in common.
 *
 * @param {string|null|undefined} header
 * @returns {object|null}
 */
export function parseOfferHeader(header) {
  if (!header) return null;
  try {
    const parsed = JSON.parse(fromBase64(header));
    return isOffer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The offer a 402 response carries, or null if it is a 402 without one.
 *
 * Reads the `PAYMENT-REQUIRED` header first and the JSON body second. The
 * body is returned too, whatever it held: a gateway puts the price, the pass
 * header name and the place to pay in there, which is worth showing a person.
 *
 * @param {Response} response
 * @returns {Promise<{ offer: object|null, body: any }>}
 */
export async function readOffer(response) {
  let body = null;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  const fromHeader = parseOfferHeader(response.headers.get('payment-required'));
  if (fromHeader) return { offer: fromHeader, body };

  return { offer: isOffer(body) ? body : null, body };
}

/** Whether a value has the shape of an x402 offer. */
export function isOffer(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.accepts);
}

/**
 * The first entry the payer can sign.
 *
 * The order of `accepts` is the server's preference and is kept: the first
 * `exact`-scheme entry on an EVM chain wins, restricted to `networks` when
 * the caller has funds on some chains and not others.
 *
 * @param {object[]} accepts
 * @param {{ networks?: string[] }} [options]
 * @returns {object|null}
 */
export function selectAccept(accepts, { networks } = {}) {
  if (!Array.isArray(accepts)) return null;
  const allowed = networks ? new Set(networks.map((n) => String(n).toLowerCase())) : null;
  return (
    accepts.find((entry) => {
      if (!entry || (entry.scheme ?? 'exact') !== 'exact') return false;
      if (evmChainId(entry.network) === null) return false;
      return !allowed || allowed.has(String(entry.network).toLowerCase());
    }) ?? null
  );
}

/**
 * The EIP-712 domain for an entry: the token's, never x402's.
 *
 * `verifyingContract` is the token's address and `name`/`version` are what
 * that token returns from its own domain. Getting this wrong is not a soft
 * failure: the recovered signer is simply some other address.
 *
 * @param {object} entry
 * @returns {{ name: string, version: string, chainId: number, verifyingContract: string }}
 */
export function domainFor(entry) {
  const chainId = evmChainId(entry?.network);
  if (chainId === null) throw new Error(`Not an EVM network, cannot sign an EIP-3009 authorization: ${entry?.network}`);
  if (!entry.asset) throw new Error('The offer names no token contract (`asset`)');

  const known = KNOWN_TOKEN_DOMAINS[`${String(entry.network).toLowerCase()}:${String(entry.asset).toLowerCase()}`];
  const name = entry.extra?.name ?? known?.name;
  const version = entry.extra?.version ?? known?.version;
  if (!name || !version) {
    throw new Error(
      `The offer carries no EIP-712 domain for ${entry.asset} on ${entry.network} and it is not a token this client knows`,
    );
  }
  return { name, version, chainId, verifyingContract: entry.asset };
}

/**
 * The amount an entry asks for, in the token's smallest unit, as a string.
 * Reads v2's `amount` and the older `maxAmountRequired`.
 */
export function requiredAmount(entry) {
  const raw = entry?.amount ?? entry?.maxAmountRequired;
  if (raw === undefined || raw === null || raw === '') throw new Error('The offer names no amount');
  const value = BigInt(raw);
  if (value < 0n) throw new Error(`The offer names a negative amount: ${raw}`);
  return String(value);
}

/**
 * The entry's price in dollars, when the token is a dollar stablecoin this
 * client knows the decimals of. Null for anything else, so a price cap can
 * refuse what it cannot price rather than let it through.
 *
 * @param {object} entry
 * @returns {number|null}
 */
export function amountUsd(entry) {
  const known = KNOWN_TOKEN_DOMAINS[`${String(entry?.network).toLowerCase()}:${String(entry?.asset).toLowerCase()}`];
  if (!known) return null;
  return Number(requiredAmount(entry)) / 10 ** known.decimals;
}

/** A random 32-byte nonce, hex. EIP-3009 nonces are arbitrary bytes32. */
export function randomNonce() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The authorization to sign.
 *
 * `validAfter` is 0 rather than "now": clocks differ between the payer and the
 * chain, and a validAfter in the payer's near future makes the authorization
 * briefly unusable for no benefit. `validBefore` is bounded by the entry's
 * own `maxTimeoutSeconds`, which is how long the server promises to settle
 * within; signing for longer would leave a spendable authorization lying
 * around after the server has given up on it.
 *
 * @param {object} args
 * @param {string} args.from
 * @param {string} args.to
 * @param {string} args.value
 * @param {number} [args.validForSeconds=600]
 * @param {string} [args.nonce]
 * @param {number} [args.now] unix seconds, for tests
 */
export function buildAuthorization({ from, to, value, validForSeconds = 600, nonce, now = Math.floor(Date.now() / 1000) }) {
  if (!from) throw new Error('an authorization needs `from`');
  if (!to) throw new Error('an authorization needs `to`');
  return {
    from,
    to,
    value: String(value),
    validAfter: '0',
    validBefore: String(now + Math.max(1, Math.floor(validForSeconds))),
    nonce: nonce ?? randomNonce(),
  };
}

/**
 * Sign one `accepts` entry with a wallet.
 *
 * @param {object} entry
 * @param {import('./wallet.js').Wallet} wallet
 * @param {{ validForSeconds?: number, nonce?: string, now?: number }} [options]
 * @returns {{ payment: object, header: string, authorization: object, domain: object }}
 */
export function signPayment(entry, wallet, options = {}) {
  const domain = domainFor(entry);
  if (!entry.payTo) throw new Error('The offer names nobody to pay (`payTo`)');

  const authorization = buildAuthorization({
    from: wallet.address,
    to: entry.payTo,
    value: requiredAmount(entry),
    validForSeconds: options.validForSeconds ?? entry.maxTimeoutSeconds ?? 600,
    nonce: options.nonce,
    now: options.now,
  });

  const signature = wallet.signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', authorization);

  const payment = {
    x402Version: X402_VERSION,
    scheme: entry.scheme ?? 'exact',
    network: entry.network,
    payload: { signature, authorization },
  };

  return { payment, header: encodePaymentHeader(payment), authorization, domain };
}

/** base64 of a payment, as the proof headers carry it. */
export function encodePaymentHeader(payment) {
  return toBase64(JSON.stringify(payment));
}

/** Inverse of {@link encodePaymentHeader}. Null when the header is not base64 JSON. */
export function decodePaymentHeader(header) {
  if (!header) return null;
  try {
    const parsed = JSON.parse(fromBase64(header));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What a paid response gives back that is worth keeping.
 *
 * A gateway answers a proof with a receipt naming a pass — a bearer token
 * good for a while — and the header to present it in. A plain x402 resource
 * answers with the resource itself and a `PAYMENT-RESPONSE` header holding the
 * settlement. Both are read; only the pass is something to store.
 *
 * @param {Response} response
 * @param {any} body the parsed JSON body, if there was one
 * @returns {{ pass: string|null, header: string, expires: string|null, settlement: object|null }}
 */
export function readReceipt(response, body) {
  const headerName = (typeof body?.header === 'string' && body.header) || 'x-crawl-pass';
  const fromBody = typeof body?.pass === 'string' ? body.pass : (body?.pass?.token ?? body?.token ?? null);
  const pass = fromBody ?? response.headers.get(headerName) ?? null;
  const expires = body?.expires ?? body?.pass?.expires ?? response.headers.get(`${headerName}-expires`) ?? null;

  let settlement = null;
  const settled = response.headers.get('payment-response') ?? response.headers.get('x-payment-response');
  if (settled) {
    try {
      settlement = JSON.parse(fromBase64(settled));
    } catch {
      settlement = null;
    }
  }

  return { pass: typeof pass === 'string' ? pass : null, header: headerName, expires: expires ? String(expires) : null, settlement };
}
