import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSealedPayer, decodeBundle, deriveDataKey, payerFromEnv, sealPayerKey, X402LockedError } from '../src/sealed.js';
import { ADDRESS_ONE, KEY_ONE, startGateway } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/x402.js', import.meta.url));
const PASS = 'correct horse battery staple';

// One seal for the whole file: PBKDF2 at 600k is deliberately slow.
const made = await sealPayerKey(KEY_ONE, PASS);
const dekB64 = Buffer.from(await deriveDataKey(decodeBundle(made.sealed), PASS)).toString('base64');

function payer(extra = {}) {
  const lines = [];
  const p = createSealedPayer({ site: 'test.site', sealed: made.sealed, log: (l) => lines.push(l), ...extra });
  return { p, lines };
}

test('the sealed bundle is ciphertext: no key in it, the address in the clear', () => {
  const raw = Buffer.from(made.sealed, 'base64').toString('utf8');
  assert.ok(!raw.includes(KEY_ONE.slice(2)));
  assert.equal(made.address, ADDRESS_ONE);
  assert.equal(decodeBundle(made.sealed).address, ADDRESS_ONE);
  assert.match(made.recoveryKey, /\S{20,}/);
});

test('locked: payments pause, the 402 comes back, one [alert] line per lock', async () => {
  const gateway = await startGateway();
  const { p, lines } = payer();
  try {
    assert.equal(p.locked, true);
    const a = await p.fetch(`${gateway.url}/page`);
    const b = await p.fetch(`${gateway.url}/other`);
    assert.equal(a.status, 402);
    assert.equal(b.status, 402);
    assert.equal(gateway.state.payments.length, 0);
    assert.equal(lines.filter((l) => l.startsWith('[alert] test.site: operator keys locked')).length, 1);
    await assert.rejects(p.pay(`${gateway.url}/crawl`), X402LockedError);
  } finally {
    await gateway.close();
  }
});

test('a wrong data key does not unlock; the right one pays, then lock pauses again', async () => {
  const gateway = await startGateway();
  const { p, lines } = payer();
  try {
    await assert.rejects(p.unlock(Buffer.alloc(32, 7).toString('base64')), /does not open/);
    const out = await p.unlock(dekB64);
    assert.equal(out.unlocked, true);
    const days = (Date.parse(out.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7, `default unlock is 7d, got ${days}`);

    const res = await p.fetch(`${gateway.url}/page`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);

    await assert.rejects(p.lock(Buffer.alloc(32, 1).toString('base64')), /does not open/);
    await p.lock(dekB64);
    assert.equal(p.locked, true);
    // The pass bought while unlocked is still presented.
    assert.equal((await p.fetch(`${gateway.url}/again`)).status, 200);
    assert.equal(gateway.state.payments.length, 1);
    // A new lock alerts again (once).
    const other = await startGateway();
    try {
      await p.fetch(`${other.url}/x`);
      await p.fetch(`${other.url}/y`);
    } finally {
      await other.close();
    }
    assert.equal(lines.filter((l) => l.startsWith('[alert]')).length, 1);
  } finally {
    await gateway.close();
  }
});

test('the TTL expires the unlock', async () => {
  let now = Date.now();
  const { p } = payer({ now: () => now });
  await p.unlock(dekB64, '1h');
  assert.equal(p.locked, false);
  now += 3601_000;
  assert.equal(p.locked, true);
  p.lockNow();
});

test('a restart (a new payer from the same env) starts locked', async () => {
  const { p } = payer();
  await p.unlock(dekB64);
  const { p: restarted } = payer();
  assert.equal(restarted.locked, true);
  p.lockNow();
});

test('payerFromEnv: sealed wins over plaintext; no env fallback while sealed', () => {
  const lines = [];
  const env = { X402_SEALED_KEY: made.sealed, X402_PRIVATE_KEY: KEY_ONE };
  const got = payerFromEnv({ site: 'env.sealed', env, log: (l) => lines.push(l) });
  assert.equal(got.kind, 'sealed');
  assert.equal(got.payer.locked, true);
  assert.equal(got.status().unlocked, false);
  // Same process, same site: the same payer (one unlock serves every module copy).
  assert.equal(payerFromEnv({ site: 'env.sealed', env }), got);
});

test('payerFromEnv: plaintext only in the migration window, with a [warn]', () => {
  const lines = [];
  const legacy = payerFromEnv({ site: 'env.legacy', env: { X402_PRIVATE_KEY: KEY_ONE }, log: (l) => lines.push(l) });
  assert.equal(legacy.kind, 'plaintext');
  assert.equal(legacy.address, ADDRESS_ONE);
  assert.match(lines[0], /^\[warn\] env.legacy: x402 payer key is plaintext/);
  assert.equal(payerFromEnv({ site: 'env.off', env: { X402_PRIVATE_KEY: KEY_ONE, X402_LEGACY_PLAINTEXT_KEY: 'off' } }), null);
  assert.equal(payerFromEnv({ site: 'env.none', env: {} }), null);
});

function cli(args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, X402_PRIVATE_KEY: '' } }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

test('the control server + CLI: status, unlock with the passphrase, lock', async () => {
  const { p } = payer();
  const server = await p.listen({ port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const seen = await (await fetch(url)).json();
    assert.equal(seen.unlocked, false);
    assert.ok(seen.seal?.kdf, 'GET hands out the seal so the CLI can derive the key');
    assert.ok(!JSON.stringify(seen).includes(KEY_ONE.slice(2)));

    const bad = await cli(['vault', 'unlock', url], 'not the passphrase\n');
    assert.equal(bad.code, 1);
    assert.equal(p.locked, true);

    const good = await cli(['vault', 'unlock', url, '--ttl', '8h'], `${PASS}\n`);
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, /unlocked until/);
    assert.equal(p.locked, false);

    const st = await cli(['vault', 'status', url], '');
    assert.match(st.stdout, /unlocked until/);

    const locked = await cli(['vault', 'lock', url], `${PASS}\n`);
    assert.equal(locked.code, 0, locked.stderr);
    assert.equal(p.locked, true);

    const noAuth = await fetch(`${url}/lock`, { method: 'POST', body: '{}' });
    assert.equal(noAuth.status, 403);
  } finally {
    server.close();
    p.lockNow();
  }
});

test('x402 vault seal prints a bundle that unlocks with the same passphrase', async () => {
  const out = await cli(['vault', 'seal'], `${KEY_ONE}\n${PASS}\n${PASS}\n`);
  assert.equal(out.code, 0, out.stderr);
  const sealed = out.stdout.trim().replace(/^X402_SEALED_KEY=/, '');
  assert.equal(decodeBundle(sealed).address, ADDRESS_ONE);
  assert.match(out.stderr, /recovery key/);
  assert.ok(!out.stdout.includes(KEY_ONE.slice(2)));
  const p = createSealedPayer({ site: 's', sealed, log: () => {} });
  const dek = Buffer.from(await deriveDataKey(decodeBundle(sealed), PASS)).toString('base64');
  await p.unlock(dek);
  assert.equal(p.locked, false);
  p.lockNow();
});
