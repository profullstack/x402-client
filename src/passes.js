/**
 * Where passes live between requests.
 *
 * A gateway sells a day at a time, and a pass is a bearer token: whoever
 * presents it gets in, and presenting it costs nothing. So the whole value of
 * a client that remembers passes is that the second request to a site — and
 * the thousandth, from a crawler — never pays again. Keyed by origin, because
 * a pass opens a site rather than a page.
 *
 * Two stores. Memory for a process that lives as long as its passes are
 * worth; a file for a CLI that is invoked once per URL and would otherwise
 * buy the same day a thousand times.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * @typedef {{
 *   token: string,
 *   header: string,
 *   expires: string|null,
 *   boughtAt: string,
 *   url: string|null,
 * }} StoredPass
 */

/** Whether a pass is still worth presenting. Unknown expiry counts as live. */
export function isLive(pass, now = Date.now()) {
  if (!pass?.token) return false;
  if (!pass.expires) return true;
  const at = Date.parse(pass.expires);
  return Number.isNaN(at) ? true : at > now;
}

/** The origin a URL's pass is filed under. */
export function originOf(url) {
  return new URL(String(url)).origin;
}

/**
 * Passes kept in memory for the life of the process.
 *
 * @returns {import('../index.d.ts').PassStore}
 */
export function memoryStore() {
  const passes = new Map();
  return {
    get: (origin) => {
      const pass = passes.get(origin) ?? null;
      return isLive(pass) ? pass : null;
    },
    set: (origin, pass) => {
      passes.set(origin, pass);
    },
    delete: (origin) => {
      passes.delete(origin);
    },
    all: () => Object.fromEntries(passes),
  };
}

/**
 * The default file: `$XDG_CONFIG_HOME/x402-client/passes.json`, or the same
 * under `~/.config`.
 */
export function defaultPassPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'x402-client', 'passes.json');
}

/**
 * Passes kept in a JSON file, read on every get and rewritten on every set.
 *
 * The file is small — one line per site — and re-reading it is what lets two
 * CLI invocations in a row, or two processes, share what one of them bought.
 * Written with mode 0600 since a pass is a bearer token, and created with its
 * directory when missing. A file that cannot be read is treated as empty
 * rather than fatal: losing a cache costs a dollar, crashing costs the run.
 *
 * @param {string} [path]
 * @returns {import('../index.d.ts').PassStore}
 */
export function fileStore(path = defaultPassPath()) {
  const read = () => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const write = (all) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  };

  return {
    get: (origin) => {
      const pass = read()[origin] ?? null;
      return isLive(pass) ? pass : null;
    },
    set: (origin, pass) => {
      const all = read();
      all[origin] = pass;
      write(all);
    },
    delete: (origin) => {
      const all = read();
      delete all[origin];
      write(all);
    },
    all: () => read(),
    path,
  };
}
