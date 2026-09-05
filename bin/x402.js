#!/usr/bin/env node
/**
 * x402 from a shell.
 *
 *   x402 pay <url>          pay the offer at a URL, print the receipt as JSON
 *   x402 pass <url>         print the pass for a URL's site, buying one if needed
 *   x402 fetch <url>        fetch a URL, paying if it asks, print the body
 *   x402 address            the address the key controls, to fund it
 *   x402 passes             the passes on file
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

const HELP = `usage: x402 <command> [options]

commands
  pay <url>        pay the offer at <url> and print the receipt (JSON)
  pass <url>       print the pass for <url>'s site, buying one if none is on file
  fetch <url>      fetch <url>, paying if it asks, and print the body
  address          print the address the key controls
  passes           list the passes on file

options
  --key-file <path>    read the private key from a file (or set X402_PRIVATE_KEY)
  --max-usd <n>        refuse any single payment above this (default 5)
  --network <caip2>    only pay on this network, e.g. eip155:8453; repeatable
  --store <path>       where passes are filed (default ~/.config/x402-client/passes.json)
  -H, --header <k: v>  extra request header; repeatable
  --json               print machine-readable output for pass and fetch
  -h, --help           this
`;

function parse(argv) {
  const opts = { headers: [], networks: [], json: false };
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
    else if (a === '--store') opts.store = next();
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

function headersFrom(list) {
  const headers = {};
  for (const line of list) {
    const at = line.indexOf(':');
    if (at < 1) fail(`header must be "Name: value", got ${JSON.stringify(line)}`);
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

async function main() {
  const { opts, command, args } = parse(process.argv.slice(2));
  if (opts.help || !command) {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 2);
  }

  const store = fileStore(opts.store);
  const key = keyFrom(opts);
  const needsKey = command === 'pay' || command === 'address';
  if (needsKey && !key) fail('no key: set X402_PRIVATE_KEY or pass --key-file <path>');

  const client = createClient({
    key: key ?? undefined,
    store,
    maxUsd: Number.isFinite(opts.maxUsd) ? opts.maxUsd : undefined,
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
