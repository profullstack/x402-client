import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADDRESS_ONE, KEY_ONE, startGateway } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/x402.js', import.meta.url));

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, X402_PRIVATE_KEY: '', ...env } }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('address prints the address the key controls', async () => {
  const { code, stdout } = await run(['address'], { X402_PRIVATE_KEY: KEY_ONE });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), ADDRESS_ONE);
});

test('without a key, paying commands say so and exit 2', async () => {
  const { code, stderr } = await run(['address']);
  assert.equal(code, 2);
  assert.match(stderr, /X402_PRIVATE_KEY/);
});

test('pass buys once and then answers from the file', async () => {
  const gateway = await startGateway();
  const store = join(mkdtempSync(join(tmpdir(), 'x402-cli-')), 'passes.json');
  try {
    const first = await run(['pass', `${gateway.url}/crawl`, '--store', store], { X402_PRIVATE_KEY: KEY_ONE });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout.trim(), /^cp_test1/);

    // No key this time: the pass is on file, so none is needed.
    const second = await run(['pass', `${gateway.url}/other`, '--store', store]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.equal(gateway.state.payments.length, 1);

    const listed = await run(['passes', '--store', store]);
    assert.match(listed.stdout, new RegExp(`^${gateway.url}\\tx-crawl-pass\\t`));

    const fetched = await run(['fetch', `${gateway.url}/page`, '--store', store]);
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.equal(fetched.stdout.trim(), '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);
  } finally {
    await gateway.close();
  }
});

test('pay prints a receipt as JSON', async () => {
  const gateway = await startGateway();
  const store = join(mkdtempSync(join(tmpdir(), 'x402-cli-')), 'passes.json');
  try {
    const { code, stdout } = await run(['pay', `${gateway.url}/crawl`, '--store', store, '--max-usd', '2'], { X402_PRIVATE_KEY: KEY_ONE });
    assert.equal(code, 0);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.payer, ADDRESS_ONE);
    assert.equal(receipt.amountUsd, 1);
    assert.match(receipt.pass, /^cp_test1/);
    assert.equal(receipt.header, 'x-crawl-pass');
  } finally {
    await gateway.close();
  }
});

test('a refused payment exits 1 with the server’s reason', async () => {
  const gateway = await startGateway({ mode: 'reject' });
  const store = join(mkdtempSync(join(tmpdir(), 'x402-cli-')), 'passes.json');
  try {
    const { code, stderr } = await run(['pay', `${gateway.url}/crawl`, '--store', store], { X402_PRIVATE_KEY: KEY_ONE });
    assert.equal(code, 1);
    assert.match(stderr, /insufficient funds/);
  } finally {
    await gateway.close();
  }
});

test('the price cap is honoured from the command line', async () => {
  const gateway = await startGateway();
  const store = join(mkdtempSync(join(tmpdir(), 'x402-cli-')), 'passes.json');
  try {
    const { code, stderr } = await run(['pay', `${gateway.url}/crawl`, '--store', store, '--max-usd', '0.10'], { X402_PRIVATE_KEY: KEY_ONE });
    assert.equal(code, 1);
    assert.match(stderr, /Refusing to pay \$1\.00/);
    assert.equal(gateway.state.payments.length, 0);
  } finally {
    await gateway.close();
  }
});

test('help and a bad command', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: x402/);
  const bad = await run(['dance']);
  assert.equal(bad.code, 2);
});
