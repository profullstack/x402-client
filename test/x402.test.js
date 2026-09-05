import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  amountUsd,
  buildAuthorization,
  decodePaymentHeader,
  domainFor,
  encodePaymentHeader,
  readOffer,
  readReceipt,
  recoverTypedDataSigner,
  requiredAmount,
  selectAccept,
  signPayment,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  walletFromKey,
} from '../src/index.js';
import { ADDRESS_ONE, KEY_ONE, offerFor, PAY_TO, USDC_BASE } from './helpers.js';

const offer = offerFor('https://site.test/crawl');

test('the first signable option wins, in the server’s order', () => {
  assert.equal(selectAccept(offer.accepts).network, 'eip155:8453');
  assert.equal(selectAccept(offer.accepts, { networks: ['eip155:137'] }).network, 'eip155:137');
  assert.equal(selectAccept(offer.accepts, { networks: ['EIP155:137'] }).network, 'eip155:137');
  assert.equal(selectAccept(offer.accepts, { networks: ['eip155:1'] }), null);
});

test('options that are not exact, or not EVM, are skipped', () => {
  const accepts = [
    { scheme: 'upto', network: 'eip155:8453', amount: '1' },
    { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '1' },
    { scheme: 'exact', network: 'eip155:137', amount: '1' },
  ];
  assert.equal(selectAccept(accepts).network, 'eip155:137');
  assert.equal(selectAccept([]), null);
  assert.equal(selectAccept(undefined), null);
});

test('the domain is the token’s own, taken from extra or from the table', () => {
  const [base] = offer.accepts;
  assert.deepEqual(domainFor(base), { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE });

  const bare = { ...base, extra: undefined };
  assert.deepEqual(domainFor(bare), { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE });

  const lower = { ...bare, asset: USDC_BASE.toLowerCase() };
  assert.equal(domainFor(lower).name, 'USD Coin');

  assert.throws(() => domainFor({ ...bare, asset: '0x0000000000000000000000000000000000000001' }), /no EIP-712 domain/);
  assert.throws(() => domainFor({ ...base, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }), /Not an EVM network/);
});

test('the amount reads v2 and the older field, and refuses nonsense', () => {
  assert.equal(requiredAmount({ amount: '1000000' }), '1000000');
  assert.equal(requiredAmount({ maxAmountRequired: 2500 }), '2500');
  assert.throws(() => requiredAmount({}), /no amount/);
  assert.throws(() => requiredAmount({ amount: '-1' }), /negative/);
  assert.throws(() => requiredAmount({ amount: 'lots' }));
});

test('a dollar of USDC is a dollar, and an unknown token has no price', () => {
  assert.equal(amountUsd(offer.accepts[0]), 1);
  assert.equal(amountUsd({ ...offer.accepts[0], amount: '250000' }), 0.25);
  assert.equal(amountUsd({ network: 'eip155:8453', asset: '0x0000000000000000000000000000000000000001', amount: '1' }), null);
});

test('an authorization is valid from the start and for as long as asked', () => {
  const auth = buildAuthorization({ from: ADDRESS_ONE, to: PAY_TO, value: '1000000', validForSeconds: 300, now: 1_800_000_000 });
  assert.equal(auth.validAfter, '0');
  assert.equal(auth.validBefore, '1800000300');
  assert.match(auth.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(buildAuthorization({ from: ADDRESS_ONE, to: PAY_TO, value: 1 }).nonce, auth.nonce);
  assert.throws(() => buildAuthorization({ to: PAY_TO, value: 1 }), /from/);
});

test('a signed payment carries exactly what the offer asked, and recovers to the payer', () => {
  const wallet = walletFromKey(KEY_ONE);
  const [entry] = offer.accepts;
  const { payment, header, authorization, domain } = signPayment(entry, wallet, { now: 1_800_000_000 });

  assert.equal(payment.x402Version, 2);
  assert.equal(payment.scheme, 'exact');
  assert.equal(payment.network, 'eip155:8453');
  assert.equal(authorization.from, ADDRESS_ONE);
  assert.equal(authorization.to, PAY_TO);
  assert.equal(authorization.value, '1000000');
  // Bounded by the offer's own settlement window.
  assert.equal(authorization.validBefore, String(1_800_000_000 + 300));

  const signer = recoverTypedDataSigner(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', authorization, payment.payload.signature);
  assert.equal(signer, ADDRESS_ONE);

  assert.deepEqual(decodePaymentHeader(header), payment);
  assert.equal(decodePaymentHeader('not base64 json'), null);
  assert.equal(decodePaymentHeader(''), null);
  assert.equal(encodePaymentHeader(payment), Buffer.from(JSON.stringify(payment)).toString('base64'));
});

test('the offer is read from the PAYMENT-REQUIRED header or the JSON body', async () => {
  const fromBody = await readOffer(new Response(JSON.stringify({ error: 'pay', ...offer }), { status: 402 }));
  assert.equal(fromBody.offer.accepts.length, 2);
  assert.equal(fromBody.body.error, 'pay');

  const encoded = Buffer.from(JSON.stringify(offer)).toString('base64');
  const fromHeader = await readOffer(new Response('nope', { status: 402, headers: { 'payment-required': encoded } }));
  assert.equal(fromHeader.offer.accepts.length, 2);
  assert.equal(fromHeader.body, 'nope');

  const none = await readOffer(new Response('Payment required', { status: 402 }));
  assert.equal(none.offer, null);
  assert.equal(none.body, 'Payment required');
});

test('a receipt yields the pass from the body, the nested token, or the header', () => {
  const body = { pass: 'cp_a.b', header: 'x-crawl-pass', expires: '2026-09-06T00:00:00.000Z' };
  assert.deepEqual(readReceipt(new Response('', { status: 200 }), body), {
    pass: 'cp_a.b',
    header: 'x-crawl-pass',
    expires: '2026-09-06T00:00:00.000Z',
    settlement: null,
  });

  const nested = readReceipt(new Response('', { status: 200 }), { pass: { token: 'cp_c.d', expires: 'later' }, header: 'x-day-pass' });
  assert.equal(nested.pass, 'cp_c.d');
  assert.equal(nested.header, 'x-day-pass');
  assert.equal(nested.expires, 'later');

  const headers = { 'x-crawl-pass': 'cp_e.f', 'x-crawl-pass-expires': 'soon' };
  const fromHeader = readReceipt(new Response('', { status: 200, headers }), 'not json');
  assert.equal(fromHeader.pass, 'cp_e.f');
  assert.equal(fromHeader.expires, 'soon');

  const settled = Buffer.from(JSON.stringify({ success: true, transaction: '0x1' })).toString('base64');
  const resource = readReceipt(new Response('', { status: 200, headers: { 'payment-response': settled } }), null);
  assert.equal(resource.pass, null);
  assert.deepEqual(resource.settlement, { success: true, transaction: '0x1' });
});
