/**
 * A payer whose key is sealed: it pays only while an operator has unlocked it.
 *
 * A crawler that pays needs a private key around the clock, and a private key
 * in the environment is readable by anyone who gets root on the box. So the
 * key is kept sealed instead (PBKDF2 600k -> HKDF -> AES-256-GCM, via
 * @profullstack/sealed-secrets) in `X402_SEALED_KEY`, which is ciphertext and
 * safe to keep in an env file. An operator unlocks it with a passphrase only
 * they hold: the `x402 vault unlock` CLI derives the data key on their machine
 * and sends only that key to a small control server on a loopback port. The
 * process keeps it in memory with a TTL (7 days by default, 7 at most). A
 * restart, a Lock or the TTL forgets it.
 *
 * While locked, payments pause and nothing else does: the fetch is the plain
 * fetch (a 402 comes back as a 402, filed passes are still presented), and
 * one `[alert]` line is logged per lock for the fleet alert path to pick up.
 *
 * The key is unsealed just before a payment is signed and the client that
 * holds it is dropped right after.
 */

import { UnlockStore, base64ToBytes, bytesToBase64, createSealer, isCipherBlob, isSealRecord, parseTtl, wipe } from '@profullstack/sealed-secrets';

import { createClient } from './client.js';
import { memoryStore } from './passes.js';
import { walletFromKey } from './wallet.js';

/** One sealer for every app: the shared crawler key seals once and opens anywhere. */
export const sealer = createSealer({ app: 'x402-client', scope: 'operator' });
export const SUBJECT = 'x402-payer';
const FIELD = 'x402_private_key';
export const DEFAULT_UNLOCK_TTL = '7d';
export const BUNDLE_VERSION = 1;

/**
 * Seal a private key under a passphrase. Returns the env value (ciphertext,
 * safe to store) and a recovery key to show once and never store.
 *
 * @param {string} privateKey hex, with or without 0x
 * @param {string} passphrase
 */
export async function sealPayerKey(privateKey, passphrase, { iterations } = {}) {
  const address = walletFromKey(privateKey).address;
  const { dek, seal, recoveryKey } = await sealer.createSeal(passphrase, SUBJECT, iterations);
  try {
    const blob = await sealer.sealSecrets(dek, { [FIELD]: String(privateKey).trim() }, SUBJECT, FIELD);
    return { sealed: encodeBundle({ v: BUNDLE_VERSION, address, seal, blob }), address, recoveryKey };
  } finally {
    wipe(dek);
  }
}

export function encodeBundle(bundle) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(bundle)));
}

/** @returns {{ v: number, address: string, seal: object, blob: object }} */
export function decodeBundle(text) {
  let bundle;
  try {
    bundle = JSON.parse(new TextDecoder().decode(base64ToBytes(String(text).trim())));
  } catch {
    throw new Error('X402_SEALED_KEY is not a sealed key bundle (make one with `x402 vault seal`)');
  }
  if (bundle?.v !== BUNDLE_VERSION || !isSealRecord(bundle.seal) || !isCipherBlob(bundle.blob) || !/^0x[0-9a-fA-F]{40}$/.test(bundle.address ?? '')) {
    throw new Error('X402_SEALED_KEY is not a sealed key bundle (make one with `x402 vault seal`)');
  }
  return bundle;
}

/** The data key for a bundle, derived from the passphrase (client side). */
export async function deriveDataKey(bundleOrSeal, passphrase) {
  const seal = bundleOrSeal?.seal ?? bundleOrSeal;
  return sealer.unlockSeal(seal, passphrase, SUBJECT);
}

export class X402LockedError extends Error {
  constructor(site) {
    super(`${site}: the x402 payer key is locked; unlock it with \`x402 vault unlock\` to resume payments`);
    this.name = 'X402LockedError';
    this.code = 'locked';
    this.status = 423;
  }
}

/**
 * @param {{
 *   site: string,
 *   sealed: string,
 *   clientOptions?: object,
 *   fetch?: typeof fetch,
 *   log?: (line: string) => void,
 *   now?: () => number,
 * }} options
 */
export function createSealedPayer(options) {
  const { site, clientOptions = {}, log = (line) => console.error(line) } = options;
  if (!site) throw new Error('createSealedPayer needs a site name for its alert line');
  const bundle = decodeBundle(options.sealed);
  const f = options.fetch ?? clientOptions.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sessions = new UnlockStore(options.now ? { now: options.now } : {});
  // Passes outlive locks: a pass bought while unlocked is still presented after.
  const store = clientOptions.store && clientOptions.store !== 'file' ? clientOptions.store : memoryStore();
  const plain = createClient({ ...clientOptions, key: undefined, wallet: undefined, store, fetch: f });
  let alerted = false;

  const alertOnce = () => {
    if (alerted) return;
    alerted = true;
    log(`[alert] ${site}: operator keys locked, unlock to resume (x402 payments paused; run \`x402 vault unlock\`)`);
  };

  /** A paying client for exactly one payment. Throws X402LockedError while locked. */
  const payingClient = async () => {
    const dek = sessions.get(SUBJECT);
    if (!dek) {
      alertOnce();
      throw new X402LockedError(site);
    }
    const map = await sealer.unsealSecrets(dek, bundle.blob, SUBJECT, FIELD);
    const wallet = walletFromKey(map[FIELD]);
    delete map[FIELD];
    return createClient({ ...clientOptions, key: undefined, wallet, store, fetch: f });
  };

  /** fetch that pays while unlocked and is the plain fetch while locked. */
  const paidFetch = async (input, init = {}) => {
    const first = await plain.fetch(input, init, { pay: false });
    if (first.status !== 402) return first;
    if (!sessions.get(SUBJECT)) {
      alertOnce();
      return first;
    }
    // Re-ask with the paying client: one extra request, and only on a 402.
    await first.body?.cancel?.().catch(() => {});
    const client = await payingClient();
    return client.fetch(input, init);
  };

  const pay = async (url, opts) => (await payingClient()).pay(url, opts);

  const status = () => ({ site, address: bundle.address, ...sessions.status(SUBJECT) });

  const unlock = async (dekBase64, ttl = DEFAULT_UNLOCK_TTL) => {
    let seconds;
    try {
      seconds = parseTtl(String(ttl || DEFAULT_UNLOCK_TTL));
    } catch {
      throw Object.assign(new Error('ttl must look like 8h or 7d (7 days at most)'), { status: 400 });
    }
    const dek = base64ToBytes(String(dekBase64 || ''));
    try {
      if (dek.length !== 32 || !(await sealer.verifyDataKey(dek, bundle.seal, SUBJECT))) {
        throw Object.assign(new Error('that passphrase does not open this sealed key'), { status: 403 });
      }
      const out = sessions.unlock(SUBJECT, dek, seconds);
      alerted = false;
      return { ...status(), ...out };
    } finally {
      wipe(dek);
    }
  };

  /** Lock needs the data key too, so nobody without the passphrase can pause payments. */
  const lock = async (dekBase64) => {
    const dek = base64ToBytes(String(dekBase64 || ''));
    try {
      if (dek.length !== 32 || !(await sealer.verifyDataKey(dek, bundle.seal, SUBJECT))) {
        throw Object.assign(new Error('that passphrase does not open this sealed key'), { status: 403 });
      }
    } finally {
      wipe(dek);
    }
    sessions.lock(SUBJECT);
    return status();
  };

  /**
   * The operator control server. Bind it to loopback (or a port published
   * only on the host's loopback): GET returns the seal so the CLI can derive
   * the data key locally; POST /unlock and /lock take that data key.
   */
  const listen = async ({ port, host = '127.0.0.1' } = {}) => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      const send = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && (path === '/' || path === '/x402/vault')) {
        return send(200, { ...status(), seal: bundle.seal });
      }
      if (req.method !== 'POST' || !['/unlock', '/lock', '/x402/vault/unlock', '/x402/vault/lock'].includes(path)) {
        return send(404, { error: 'GET / for status; POST /unlock {dek, ttl} or /lock {dek}' });
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 64 * 1024) req.destroy();
      });
      req.on('end', async () => {
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return send(400, { error: 'body must be JSON' });
        }
        try {
          if (path.endsWith('/unlock')) {
            const out = await unlock(body.dek, body.ttl);
            log(`[x402-vault] ${site}: unlocked until ${out.expiresAt}`);
            return send(200, out);
          }
          const out = await lock(body.dek);
          log(`[x402-vault] ${site}: locked by operator`);
          return send(200, out);
        } catch (e) {
          return send(e.status ?? 500, { error: e.message });
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port ?? 0, host, resolve);
    });
    server.unref?.();
    return server;
  };

  return {
    get address() {
      return bundle.address;
    },
    get locked() {
      return !sessions.get(SUBJECT);
    },
    store,
    fetch: paidFetch,
    pay,
    status,
    unlock,
    lock,
    listen,
    /** Forget the key now (tests, shutdown). */
    lockNow: () => sessions.lockAll(),
  };
}

/**
 * The payer an app should use, from its environment.
 *
 *  - `X402_SEALED_KEY` set: a sealed payer (locked until an operator unlocks).
 *    If `X402_UNLOCK_PORT` is set too, the control server listens there.
 *  - else `X402_PRIVATE_KEY` set and `X402_LEGACY_PLAINTEXT_KEY` is not "off":
 *    the old plaintext payer, with one `[warn]` line saying to seal it. This
 *    is the migration window; set the switch to off (or remove the key) to end it.
 *  - else null: no payments, plain fetch.
 *
 * Pass `env` explicitly from apps that bundle (Next inlines process.env.NAME).
 *
 * The control server starts in the background; a port clash is logged, not thrown.
 *
 * @returns {({ kind: 'sealed'|'plaintext', fetch: typeof fetch, address: string, status: () => object, payer?: object }) | null}
 */
export function payerFromEnv({ site, env = globalThis.process?.env ?? {}, clientOptions = {}, log = (l) => console.error(l), host } = {}) {
  const sealed = env.X402_SEALED_KEY?.trim();
  if (sealed) {
    // One payer per process: bundlers (Next) can evaluate this module more than
    // once, and every copy must share the one unlock and the one control port.
    const slot = Symbol.for(`@profullstack/x402-client/sealed:${site}`);
    if (globalThis[slot]) return globalThis[slot];
    const payer = createSealedPayer({ site, sealed, clientOptions, log });
    const port = Number.parseInt(env.X402_UNLOCK_PORT ?? '', 10);
    if (Number.isFinite(port) && port > 0) {
      payer
        .listen({ port, host: host ?? env.X402_UNLOCK_HOST ?? '127.0.0.1' })
        .then(() => log(`[x402-vault] ${site}: sealed payer ${payer.address} locked; unlock on port ${port}`))
        .catch((e) => log(`[warn] ${site}: x402 unlock server did not start on port ${port}: ${e.message}`));
    }
    globalThis[slot] = { kind: 'sealed', fetch: payer.fetch, address: payer.address, status: payer.status, payer };
    return globalThis[slot];
  }
  const legacy = env.X402_PRIVATE_KEY?.trim();
  if (legacy && String(env.X402_LEGACY_PLAINTEXT_KEY ?? '').toLowerCase() !== 'off') {
    const client = createClient({ ...clientOptions, key: legacy });
    log(`[warn] ${site}: x402 payer key is plaintext in env; seal it (x402 vault seal) and set X402_SEALED_KEY`);
    return {
      kind: 'plaintext',
      fetch: (input, init) => client.fetch(input, init),
      address: client.address,
      status: () => ({ site, address: client.address, unlocked: true, expiresAt: null, plaintext: true }),
    };
  }
  return null;
}
