import type { X402Client } from '../../index.js';

export interface Navigable {
  goto: (url: string, options?: any) => Promise<any>;
  setExtraHTTPHeaders: (headers: Record<string, string>) => Promise<void>;
}

/** Present the filed pass for a URL's site on every request the page makes. */
export function applyPass(page: Navigable, url: string, client: X402Client): Promise<boolean>;
/** Navigate, paying a 402 once. */
export function gotoPaid(page: Navigable, url: string, client: X402Client, options?: any): Promise<any>;
/** Make `page.goto` pay. Returns a function that restores the original. */
export function attachX402(page: Navigable, client: X402Client): () => void;
