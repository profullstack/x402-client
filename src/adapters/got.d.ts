import type { X402Client } from '../../index.js';

/** got hooks that present filed passes and pay 402s; spread into `got.extend()`. */
export function x402Hooks(client: X402Client): {
  hooks: {
    beforeRequest: Array<(options: any) => void>;
    afterResponse: Array<(response: any, retryWithMergedOptions: (options: any) => any) => any>;
  };
};
