import type { X402Client } from '../../index.js';

/** Minimal shape of an axios instance: what the adapter touches. */
export interface AxiosLike {
  request: (config: any) => Promise<any>;
  interceptors: {
    request: { use: (onFulfilled: (config: any) => any) => number; eject: (id: number) => void };
    response: { use: (onFulfilled?: (response: any) => any, onRejected?: (error: any) => any) => number; eject: (id: number) => void };
  };
}

/** Present filed passes and pay 402s on an axios instance. Returns a detach function. */
export function attachX402(axios: AxiosLike, client: X402Client): () => void;
