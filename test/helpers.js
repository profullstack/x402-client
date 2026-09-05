/**
 * A gateway to test against, shaped like @profullstack/x402-gateway.
 *
 * It really verifies: the proof's signature is recovered with the same
 * EIP-712 encoding the client signed with, and the signer has to be the
 * `from` it claims, paying the offered `payTo` the offered `amount`. What it
 * does not do is settle on chain, which is the one thing a test cannot.
 */

import { createServer } from 'node:http';

import { decodePaymentHeader, domainFor, recoverTypedDataSigner, TRANSFER_WITH_AUTHORIZATION_TYPES } from '../src/index.js';

export const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

/** A dollar a day, on Base first and Polygon second, as the gateway quotes it. */
export function offerFor(resource, { amount = '1000000' } = {}) {
  const entry = (network, asset) => ({
    scheme: 'exact',
    network,
    amount,
    asset,
    payTo: PAY_TO,
    resource,
    description: '1440 minutes of crawl access',
    mimeType: 'application/json',
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  });
  return { x402Version: 2, accepts: [entry('eip155:8453', USDC_BASE), entry('eip155:137', USDC_POLYGON)] };
}

function toBase64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/**
 * @param {object} [options]
 * @param {'gateway'|'resource'|'reject'|'header-offer'|'bare-402'} [options.mode]
 * @param {string} [options.header]
 * @param {string} [options.amount]
 */
export async function startGateway({ mode = 'gateway', header = 'x-crawl-pass', amount } = {}) {
  const state = { payments: [], hits: [], passes: new Set(), nonces: new Set() };
  let counter = 0;

  const server = createServer((req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    state.hits.push({ path: req.url, headers: { ...req.headers } });
    const offer = offerFor(url, { amount });

    const send = (status, body, headers = {}) => {
      const json = typeof body !== 'string';
      res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/html; charset=utf-8', ...headers });
      res.end(json ? JSON.stringify(body) : body);
    };

    const presented = req.headers[header];
    if (presented && state.passes.has(presented)) return send(200, '<h1>the site</h1>');

    const proof = req.headers['x-payment'] ?? req.headers['payment-signature'];
    if (proof) {
      const payment = decodePaymentHeader(proof);
      state.payments.push(payment);
      if (!payment) return send(402, { error: 'X-PAYMENT is not base64 JSON.' });

      const entry = offer.accepts.find((a) => a.network.toLowerCase() === String(payment.network).toLowerCase());
      if (!entry) return send(402, { error: 'Proof does not match an offered network.' });

      const { signature, authorization } = payment.payload ?? {};
      let signer;
      try {
        signer = recoverTypedDataSigner(domainFor(entry), TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', authorization, signature);
      } catch (err) {
        return send(402, { error: `bad signature: ${err.message}` });
      }
      const now = Math.floor(Date.now() / 1000);
      const problems = [];
      if (signer.toLowerCase() !== String(authorization.from).toLowerCase()) problems.push('signer is not from');
      if (String(authorization.to).toLowerCase() !== PAY_TO.toLowerCase()) problems.push('wrong payTo');
      if (String(authorization.value) !== entry.amount) problems.push('wrong amount');
      if (Number(authorization.validBefore) <= now) problems.push('expired');
      if (Number(authorization.validAfter) > now) problems.push('not yet valid');
      if (state.nonces.has(authorization.nonce)) problems.push('nonce already used');
      if (problems.length) return send(402, { error: problems.join(', ') });
      state.nonces.add(authorization.nonce);

      if (mode === 'reject') return send(402, { error: 'verify failed: insufficient funds' });

      if (mode === 'resource') {
        return send(200, 'the premium thing', {
          'content-type': 'text/plain',
          'payment-response': toBase64({ success: true, transaction: '0xabc', network: payment.network, payer: signer }),
        });
      }

      const pass = `cp_test${++counter}.sig`;
      state.passes.add(pass);
      const expires = new Date(Date.now() + 86_400_000).toISOString();
      return send(
        200,
        { ok: true, pass, header, expires, payer: signer, network: payment.network, use: `curl -H "${header}: ${pass}" ${url}` },
        { [header]: pass, [`${header}-expires`]: expires },
      );
    }

    if (mode === 'bare-402') return send(402, 'Payment required, but not like that.');

    if (mode === 'header-offer') {
      return send(402, 'payment required', { 'payment-required': toBase64(offer), 'content-type': 'text/plain' });
    }

    if (/text\/html/.test(String(req.headers.accept ?? ''))) return send(402, '<h1>Training crawlers pay for access here.</h1>');
    return send(402, {
      error: 'Payment required for training crawlers.',
      ...offer,
      pass: { price: '1.00 USD', minutes: 1440, header, buy: `${url.split('/').slice(0, 3).join('/')}/crawl` },
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Private key 1: the address everybody knows, 0x7E5F…5Bdf. */
export const KEY_ONE = `0x${'0'.repeat(63)}1`;
export const ADDRESS_ONE = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
