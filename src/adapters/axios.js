/**
 * axios, paying.
 *
 * Two interceptors: one puts the filed pass on every request to a site that
 * has one, the other catches a 402, pays it, and replays the request with
 * the pass. Nothing about the caller's code changes — `axios.get(url)` on a
 * paid site returns the page.
 *
 *   import axios from 'axios';
 *   import { attachX402 } from '@profullstack/x402-client/axios';
 *   attachX402(axios, createClient({ key }));
 *
 * The payment itself goes through the client's own fetch rather than through
 * axios, so an axios proxy or agent does not apply to the one request that
 * carries the proof. Everything else — the offer, the replay — is axios.
 */

import { isOffer, parseOfferHeader } from '../x402.js';
import { acceptingJson } from './util.js';

const PAID = Symbol.for('@profullstack/x402-client/paid');

/**
 * @param {import('axios').AxiosInstance} axios  the default export or an `axios.create()`
 * @param {import('../../index.d.ts').X402Client} client
 * @returns {() => void} detach
 */
export function attachX402(axios, client) {
  const onRequest = (config) => {
    const url = urlOf(config);
    if (!url) return config;
    const pass = client.passFor(url);
    if (pass) config.headers = withHeader(config.headers, pass.header, pass.token);
    return config;
  };

  const settle = async (response) => {
    const config = response?.config;
    if (!config || config[PAID]) return null;
    const url = urlOf(config);
    if (!url) return null;
    // The offer is in the 402 when the request asked for JSON. A scraper
    // wearing a browser's Accept header gets the HTML sales page instead, so
    // when there is no offer here the client asks the URL again as JSON. A
    // 402 that is not x402 fails that with `no-offer`, and the caller gets
    // the error axios raised.
    const offer = isOffer(response.data) ? response.data : parseOfferHeader(headerOf(response.headers, 'payment-required'));

    let paid;
    try {
      paid = await client.pay(url, {
        offer: offer ?? undefined,
        init: {
          method: String(config.method ?? 'get').toUpperCase(),
          headers: acceptingJson(plain(config.headers)),
        },
      });
    } catch (err) {
      if (err?.code === 'no-offer') return null;
      throw err;
    }

    if (!paid.receipt.pass) {
      // A plain x402 resource: the paid answer is the resource, in axios' shape.
      return { ...response, status: paid.status, statusText: 'OK', data: paid.body };
    }
    const headers = withHeader(plain(config.headers), paid.receipt.header, paid.receipt.pass);
    return axios.request({ ...config, headers, [PAID]: true });
  };

  // A 402 arrives as a rejection under axios' default validateStatus, and
  // as a fulfilment when the caller widened it. Both are handled.
  const onFulfilled = async (response) => (response?.status === 402 ? (await settle(response)) ?? response : response);
  const onRejected = async (error) => {
    if (error?.response?.status !== 402) throw error;
    const settled = await settle(error.response);
    if (!settled) throw error;
    return settled;
  };

  const req = axios.interceptors.request.use(onRequest);
  const res = axios.interceptors.response.use(onFulfilled, onRejected);
  return () => {
    axios.interceptors.request.eject(req);
    axios.interceptors.response.eject(res);
  };
}

function urlOf(config) {
  try {
    return config.baseURL ? new URL(String(config.url ?? ''), config.baseURL).href : new URL(String(config.url)).href;
  } catch {
    return null;
  }
}

/** Headers as a plain object, whether axios gave an AxiosHeaders or a literal. */
function plain(headers) {
  if (!headers) return {};
  if (typeof headers.toJSON === 'function') return { ...headers.toJSON() };
  return { ...headers };
}

function withHeader(headers, name, value) {
  if (headers && typeof headers.set === 'function') {
    headers.set(name, value);
    return headers;
  }
  return { ...(headers ?? {}), [name]: value };
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name) ?? null;
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}
