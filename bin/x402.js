#!/usr/bin/env node
/**
 * x402 from a shell.
 *
 *   x402 pay <url>          pay the offer at a URL, print the receipt as JSON
 *   x402 pass <url>         print the pass for a URL's site, buying one if needed
 *   x402 fetch <url>        fetch a URL, paying if it asks, print the body
 *   x402 address            the address the key controls, to fund it
 *   x402 passes             the passes on file
 *   x402 vault seal         seal a key under a passphrase -> X402_SEALED_KEY
 *   x402 vault unlock <url> unlock a running sealed payer (default 7d)
 *   x402 vault lock <url>   lock it again
 *   x402 vault status <url> locked or unlocked, and until when
 *
 * The key comes from `X402_PRIVATE_KEY` or `--key-file <path>`, never from an
 * argument: a key on the command line is in every process list and shell
 * history on the box. Passes are filed in `$XDG_CONFIG_HOME/x402-client/
 * passes.json` so a second invocation, or curl, or Lightpanda, reuses what
 * the first one bought:
 *
 *   lightpanda fetch --http-header "x-crawl-pass: $(x402 pass https://site/crawl)" https://site/page
 */

import { readFileSync } from 'node:fs';

import { createClient, X402Error } from '../src/client.js';
import { fileStore, originOf } from '../src/passes.js';
import { DEFAULT_UNLOCK_TTL, deriveDataKey, sealPayerKey } from '../src/sealed.js';

const HELP = `usage: x402 <command> [options]

commands
  pay <url>        pay the offer at <url> and print the receipt (JSON)
  pass <url>       print the pass for <url>'s site, buying one if none is on file
  fetch <url>      fetch <url>, paying if it asks, and print the body
  address          print the address the key controls
  passes           list the passes on file

  vault seal                 seal the key (prompted, or --key-file) under a passphrase;
                             prints X402_SEALED_KEY=<ciphertext> and a one-time recovery key
  vault unlock <url>...      unlock running sealed payers (their loopback control ports,
                             e.g. http://127.0.0.1:3921); one passphrase prompt for all
  vault lock <url>...        lock them (payments pause)
  vault status <url>...      show locked/unlocked and the expiry

options
  --key-file <path>    read the private key from a file (or set X402_PRIVATE_KEY)
  --max-usd <n>        refuse any single payment above this (default 5)
  --pay-to <address>   only pay this address; repeatable (or set X402_PAY_TO, comma-separated)
  --budget-usd <n>     refuse once this invocation would sign for more than this in total
  --network <caip2>    only pay on this network, e.g. eip155:8453; repeatable
  --store <path>       where passes are filed (default ~/.config/x402-client/passes.json)
  -H, --header <k: v>  extra request header; repeatable
  --json               print machine-readable output for pass and fetch
  --ttl <8h|7d>        how long an unlock lasts (default 7d, at most 7d)
  -h, --help           this
`;

function parse(argv) {
  const opts = { headers: [], networks: [], payTo: [], json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--key-file') opts.keyFile = next();
    else if (a === '--max-usd') opts.maxUsd = Number(next());
    else if (a === '--network') opts.networks.push(next());
    else if (a === '--pay-to') opts.payTo.push(next());
    else if (a === '--budget-usd') opts.budgetUsd = Number(next());
    else if (a === '--store') opts.store = next();
    else if (a === '--ttl') opts.ttl = next();
    else if (a === '-H' || a === '--header') opts.headers.push(next());
    else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else rest.push(a);
  }
  return { opts, command: rest[0], args: rest.slice(1) };
}

function fail(message, code = 2) {
  process.stderr.write(`x402: ${message}\n`);
  process.exit(code);
}

function keyFrom(opts) {
  if (opts.keyFile) return readFileSync(opts.keyFile, 'utf8').trim();
  return process.env.X402_PRIVATE_KEY?.trim() || null;
}

function payToFrom(opts) {
  const list = opts.payTo.length ? opts.payTo : (process.env.X402_PAY_TO ?? '').split(',');
  const addresses = list.map((a) => a.trim()).filter(Boolean);
  for (const a of addresses) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) fail(`--pay-to must be a 0x address, got ${JSON.stringify(a)}`);
  return addresses.length ? addresses : undefined;
}

function headersFrom(list) {
  const headers = {};
  for (const line of list) {
    const at = line.indexOf(':');
    if (at < 1) fail(`header must be "Name: value", got ${JSON.stringify(line)}`);
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/**
 * Read secrets: from a TTY with echo off, else one line each from stdin (for
 * scripts and tests). Never from argv or the environment.
 */
function makePrompter() {
  let lines = null;
  const piped = async () => {
    if (!lines) {
      let all = '';
      for await (const chunk of process.stdin) all += chunk;
      lines = all.split(/\r?\n/);
    }
    return lines.shift() ?? '';
  };
  return async (label) => {
    if (!process.stdin.isTTY) return piped();
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) process.stderr.write(s);
    };
    return new Promise((resolve) => {
      rl.question(label, (answer) => {
        rl.close();
        process.stderr.write('\n');
        resolve(answer);
      });
      muted = true;
    });
  };
}

async function vault(sub, args, opts) {
  const ask = makePrompter();
  if (sub === 'seal') {
    const key = opts.keyFile ? readFileSync(opts.keyFile, 'utf8').trim() : (await ask('private key (hex): ')).trim();
    if (!key) fail('no key to seal');
    const pass = await ask('new passphrase (10+ chars): ');
    const again = await ask('repeat passphrase: ');
    if (pass !== again) fail('the passphrases differ');
    const { sealed, address, recoveryKey } = await sealPayerKey(key, pass);
    process.stderr.write(`sealed the key for ${address}\nrecovery key (shown once, keep it offline): ${recoveryKey}\n`);
    process.stdout.write(`X402_SEALED_KEY=${sealed}\n`);
    return;
  }
  if (!['unlock', 'lock', 'status'].includes(sub)) fail(`unknown vault command ${sub ?? ''}\n\n${HELP}`);
  if (args.length === 0) fail(`vault ${sub} needs the control URL of at least one running payer`);
  const urls = args.map((u) => u.replace(/\/+$/, ''));
  const states = [];
  for (const url of urls) {
    const res = await fetch(url).catch((e) => fail(`${url}: ${e.message}`, 1));
    if (!res.ok) fail(`${url} answered ${res.status}`, 1);
    states.push(await res.json());
  }
  if (sub === 'status') {
    for (const [i, s] of states.entries()) {
      process.stdout.write(`${urls[i]}\t${s.site}\t${s.address}\t${s.unlocked ? `unlocked until ${s.expiresAt}` : 'locked'}\n`);
    }
    return;
  }
  const pass = await ask('passphrase: ');
  let failed = false;
  // One derivation per distinct seal (they are normally all the same one).
  const keys = new Map();
  for (const [i, s] of states.entries()) {
    const id = JSON.stringify(s.seal?.kdf ?? null);
    if (!keys.has(id)) {
      try {
        const dek = await deriveDataKey(s.seal, pass);
        keys.set(id, Buffer.from(dek).toString('base64'));
        dek.fill(0);
      } catch {
        keys.set(id, null);
      }
    }
    const dek = keys.get(id);
    if (!dek) {
      process.stderr.write(`${urls[i]}: that passphrase does not open this sealed key\n`);
      failed = true;
      continue;
    }
    const res = await fetch(`${urls[i]}/${sub}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub === 'unlock' ? { dek, ttl: opts.ttl ?? DEFAULT_UNLOCK_TTL } : { dek }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      process.stderr.write(`${urls[i]}: ${out.error ?? res.status}\n`);
      failed = true;
      continue;
    }
    process.stdout.write(`${urls[i]}\t${out.site}\t${out.unlocked ? `unlocked until ${out.expiresAt}` : 'locked'}\n`);
  }
  if (failed) process.exit(1);
}

async function main() {
  const { opts, command, args } = parse(process.argv.slice(2));
  if (opts.help || !command) {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 2);
  }
  if (command === 'vault') return vault(args[0], args.slice(1), opts);

  const store = fileStore(opts.store);
  const key = keyFrom(opts);
  const needsKey = command === 'pay' || command === 'address';
  if (needsKey && !key) fail('no key: set X402_PRIVATE_KEY or pass --key-file <path>');

  const client = createClient({
    key: key ?? undefined,
    store,
    maxUsd: Number.isFinite(opts.maxUsd) ? opts.maxUsd : undefined,
    budgetUsd: Number.isFinite(opts.budgetUsd) ? opts.budgetUsd : undefined,
    payTo: payToFrom(opts),
    networks: opts.networks.length ? opts.networks : undefined,
  });

  const url = args[0];
  const needsUrl = command === 'pay' || command === 'pass' || command === 'fetch';
  if (needsUrl && !url) fail(`${command} needs a URL`);

  if (command === 'address') {
    process.stdout.write(`${client.address}\n`);
    return;
  }

  if (command === 'passes') {
    const all = store.all();
    if (opts.json) process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    else {
      const rows = Object.entries(all);
      if (rows.length === 0) process.stdout.write(`no passes on file (${store.path})\n`);
      for (const [origin, pass] of rows) {
        process.stdout.write(`${origin}\t${pass.header}\t${pass.expires ?? 'no expiry'}\t${pass.token.slice(0, 24)}…\n`);
      }
    }
    return;
  }

  if (command === 'pay') {
    const result = await client.pay(url, { init: { headers: headersFrom(opts.headers) } });
    process.stdout.write(`${JSON.stringify(receiptOf(result), null, 2)}\n`);
    return;
  }

  if (command === 'pass') {
    let pass = client.passFor(url);
    if (!pass) {
      if (!key) fail(`no pass on file for ${originOf(url)} and no key to buy one: set X402_PRIVATE_KEY`);
      const result = await client.pay(url, { init: { headers: headersFrom(opts.headers) } });
      if (!result.receipt.pass) fail(`${url} took the payment but issued no pass`, 1);
      pass = client.passFor(url);
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(pass, null, 2)}\n`);
    else process.stdout.write(`${pass.token}\n`);
    return;
  }

  if (command === 'fetch') {
    const res = await client.fetch(url, { headers: headersFrom(opts.headers) });
    const text = await res.text();
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ status: res.status, headers: Object.fromEntries(res.headers), body: text }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');
    }
    if (res.status >= 400) process.exit(1);
    return;
  }

  fail(`unknown command ${command}\n\n${HELP}`);
}

function receiptOf(result) {
  return {
    status: result.status,
    payer: result.payer,
    payTo: result.payTo,
    network: result.network,
    amount: result.amount,
    amountUsd: result.amountUsd,
    nonce: result.nonce,
    pass: result.receipt.pass,
    header: result.receipt.header,
    expires: result.receipt.expires,
    settlement: result.receipt.settlement,
    body: result.body,
  };
}

main().catch((err) => {
  if (err instanceof X402Error) {
    process.stderr.write(`x402: ${err.message}\n`);
    if (err.body && typeof err.body === 'object') process.stderr.write(`${JSON.stringify(err.body, null, 2)}\n`);
    process.exit(1);
  }
  process.stderr.write(`x402: ${err?.stack ?? err}\n`);
  process.exit(1);
});
