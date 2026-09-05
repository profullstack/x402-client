import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClient, fileStore, isLive, memoryStore, X402Error } from '../src/index.js';
import { ADDRESS_ONE, KEY_ONE, PAY_TO, startGateway } from './helpers.js';

test('a 402 is paid once, and the pass opens every request after it', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE });

    const first = await client.fetch(`${gateway.url}/page`);
    assert.equal(first.status, 200);
    assert.equal(await first.text(), '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);

    const pass = client.passFor(`${gateway.url}/anything`);
    assert.ok(pass);
    assert.equal(pass.header, 'x-crawl-pass');
    assert.match(pass.token, /^cp_test1/);

    const second = await client.fetch(`${gateway.url}/another`);
    assert.equal(second.status, 200);
    assert.equal(gateway.state.payments.length, 1, 'the second request must not pay again');
    const last = gateway.state.hits.at(-1);
    assert.equal(last.headers['x-crawl-pass'], pass.token);
  } finally {
    await gateway.close();
  }
});

test('pay() reports who paid whom, and the gateway recovered the same signer', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE });
    const result = await client.pay(`${gateway.url}/crawl`);

    assert.equal(client.address, ADDRESS_ONE);
    assert.equal(result.payer, ADDRESS_ONE);
    assert.equal(result.payTo, PAY_TO);
    assert.equal(result.network, 'eip155:8453');
    assert.equal(result.amount, '1000000');
    assert.equal(result.amountUsd, 1);
    assert.equal(result.receipt.header, 'x-crawl-pass');
    assert.ok(result.receipt.pass);
    assert.ok(result.receipt.expires);
    assert.equal(result.body.payer, ADDRESS_ONE, 'the gateway recovered the signer from the proof');

    // Both proof headers went out, so either dialect of server reads one.
    const paidHit = gateway.state.hits.find((h) => h.headers['x-payment']);
    assert.ok(paidHit);
    assert.equal(paidHit.headers['payment-signature'], paidHit.headers['x-payment']);
  } finally {
    await gateway.close();
  }
});

test('the price ceiling refuses before anything is signed', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE, maxUsd: 0.5 });
    await assert.rejects(client.pay(`${gateway.url}/crawl`), (err) => {
      assert.ok(err instanceof X402Error);
      assert.equal(err.code, 'too-expensive');
      assert.match(err.message, /\$1\.00/);
      return true;
    });
    assert.equal(gateway.state.payments.length, 0);
    assert.equal(client.passFor(gateway.url), null);
  } finally {
    await gateway.close();
  }
});

test('networks narrows the option to a chain the wallet is funded on', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE, networks: ['eip155:137'] });
    const result = await client.pay(`${gateway.url}/crawl`);
    assert.equal(result.network, 'eip155:137');
    assert.equal(gateway.state.payments[0].network, 'eip155:137');

    const picky = createClient({ key: KEY_ONE, networks: ['eip155:1'] });
    await assert.rejects(picky.pay(`${gateway.url}/crawl`), (err) => err.code === 'no-option');
  } finally {
    await gateway.close();
  }
});

test('a refused proof is not retried, and says why', async () => {
  const gateway = await startGateway({ mode: 'reject' });
  try {
    const client = createClient({ key: KEY_ONE });
    await assert.rejects(client.fetch(`${gateway.url}/page`), (err) => {
      assert.ok(err instanceof X402Error);
      assert.equal(err.code, 'rejected');
      assert.match(err.message, /insufficient funds/);
      assert.equal(err.body.error, 'verify failed: insufficient funds');
      return true;
    });
    assert.equal(gateway.state.payments.length, 1, 'exactly one proof, never a second one on a guess');
    assert.equal(client.passFor(gateway.url), null);
  } finally {
    await gateway.close();
  }
});

test('a plain x402 resource is returned as paid, with the settlement and no pass', async () => {
  const gateway = await startGateway({ mode: 'resource' });
  try {
    const client = createClient({ key: KEY_ONE });
    const res = await client.fetch(`${gateway.url}/premium`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'the premium thing');
    assert.equal(client.passFor(gateway.url), null);

    const result = await client.pay(`${gateway.url}/premium`);
    assert.equal(result.receipt.pass, null);
    assert.equal(result.receipt.settlement.success, true);
    assert.equal(result.receipt.settlement.payer, ADDRESS_ONE);
  } finally {
    await gateway.close();
  }
});

test('an offer carried in the PAYMENT-REQUIRED header is read too', async () => {
  const gateway = await startGateway({ mode: 'header-offer' });
  try {
    const client = createClient({ key: KEY_ONE });
    const res = await client.fetch(`${gateway.url}/page`);
    assert.equal(res.status, 200);
    assert.equal(gateway.state.payments.length, 1);
  } finally {
    await gateway.close();
  }
});

test('a 402 that is not x402 comes back as itself', async () => {
  const gateway = await startGateway({ mode: 'bare-402' });
  try {
    const client = createClient({ key: KEY_ONE });
    const res = await client.fetch(`${gateway.url}/page`);
    assert.equal(res.status, 402);
    assert.equal(await res.text(), 'Payment required, but not like that.');
    assert.equal(gateway.state.payments.length, 0);

    await assert.rejects(client.pay(`${gateway.url}/page`), (err) => err.code === 'no-offer');
  } finally {
    await gateway.close();
  }
});

test('without a key the client can present passes but not buy them', async () => {
  const gateway = await startGateway();
  try {
    const store = memoryStore();
    const buyer = createClient({ key: KEY_ONE, store });
    await buyer.pay(`${gateway.url}/crawl`);

    const reader = createClient({ store });
    assert.equal(reader.address, null);
    const res = await reader.fetch(`${gateway.url}/page`);
    assert.equal(res.status, 200);
    assert.equal(gateway.state.payments.length, 1);

    const empty = createClient();
    await assert.rejects(empty.pay(`${gateway.url}/crawl`), (err) => err.code === 'no-key');
    const unpaid = await empty.fetch(`${gateway.url}/page`, {}, { pay: false });
    assert.equal(unpaid.status, 402);
  } finally {
    await gateway.close();
  }
});

test('a 200 never touches the wallet', async () => {
  const gateway = await startGateway();
  try {
    let calls = 0;
    const client = createClient({
      key: KEY_ONE,
      fetch: async (url, init) => {
        calls++;
        return new Response('free', { status: 200 });
      },
    });
    const res = await client.fetch(`${gateway.url}/free`);
    assert.equal(await res.text(), 'free');
    assert.equal(calls, 1);
    await assert.rejects(client.pay(`${gateway.url}/free`), (err) => err.code === 'no-offer' && err.status === 200);
  } finally {
    await gateway.close();
  }
});

test('a pass filed by one process is used by the next', async () => {
  const gateway = await startGateway();
  try {
    const path = join(mkdtempSync(join(tmpdir(), 'x402-')), 'passes.json');

    const first = createClient({ key: KEY_ONE, store: fileStore(path) });
    await first.pay(`${gateway.url}/crawl`);
    assert.equal((statSync(path).mode & 0o777).toString(8), '600');

    const second = createClient({ store: fileStore(path) });
    const res = await second.fetch(`${gateway.url}/page`);
    assert.equal(res.status, 200);
    assert.equal(gateway.state.payments.length, 1);

    const all = second.store.all();
    assert.deepEqual(Object.keys(all), [gateway.url]);
    assert.equal(all[gateway.url].url, `${gateway.url}/crawl`);
  } finally {
    await gateway.close();
  }
});

test('an expired pass is not presented', () => {
  const store = memoryStore();
  store.set('https://site.test', { token: 'cp_x.y', header: 'x-crawl-pass', expires: '2000-01-01T00:00:00.000Z', boughtAt: '', url: null });
  assert.equal(store.get('https://site.test'), null);
  assert.equal(isLive({ token: 'cp_x.y', expires: null }), true);
  assert.equal(isLive({ token: 'cp_x.y', expires: 'garbage' }), true);
  assert.equal(isLive(null), false);
});

test('a user agent is sent when the caller sets none', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE, userAgent: 'MyCrawler/1.0 (+https://example.test)' });
    await client.fetch(`${gateway.url}/page`);
    for (const hit of gateway.state.hits) assert.equal(hit.headers['user-agent'], 'MyCrawler/1.0 (+https://example.test)');
    await client.fetch(`${gateway.url}/page`, { headers: { 'user-agent': 'Other/2' } });
    assert.equal(gateway.state.hits.at(-1).headers['user-agent'], 'Other/2');
  } finally {
    await gateway.close();
  }
});
