import type { ClientOptions, X402Client } from '../../index.js';

/** A fetch that presents a filed pass and pays a 402 once, over the fetch you give it. */
export function wrapFetch(fetchImpl: typeof fetch, options?: ClientOptions & { client?: X402Client }): typeof fetch;
/** The global fetch, paying. */
export function x402Fetch(options?: ClientOptions): typeof fetch;
