import type { X402Client } from '../../index.js';

/** What the adapter needs of a Playwright Page or BrowserContext. */
export interface Routable {
  route: (pattern: string | RegExp, handler: (route: any, request: any) => Promise<void> | void) => Promise<void>;
  unroute: (pattern: string | RegExp, handler?: (route: any, request: any) => Promise<void> | void) => Promise<void>;
}

export interface Navigable {
  goto: (url: string, options?: any) => Promise<any>;
  setExtraHTTPHeaders: (headers: Record<string, string>) => Promise<void>;
}

/** Route document, XHR and fetch requests through the client: present the pass, pay a 402 once, replay. Returns a detach function. */
export function attachX402(
  target: Routable,
  client: X402Client,
  options?: { pattern?: string | RegExp; resourceTypes?: string[] },
): Promise<() => Promise<void>>;

/** Navigate, paying a 402 once via `setExtraHTTPHeaders`. */
export function gotoPaid(page: Navigable, url: string, client: X402Client, options?: any): Promise<any>;
