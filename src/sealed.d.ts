import type { ClientOptions, PayResult } from '../index.d.ts';

export declare const SUBJECT: 'x402-payer';
export declare const DEFAULT_UNLOCK_TTL: '7d';
export declare const BUNDLE_VERSION: 1;

export interface SealedBundle {
  v: 1;
  address: string;
  seal: object;
  blob: object;
}

/** Seal a private key under a passphrase. `sealed` is ciphertext (the X402_SEALED_KEY value); show `recoveryKey` once. */
export declare function sealPayerKey(
  privateKey: string,
  passphrase: string,
  options?: { iterations?: number },
): Promise<{ sealed: string; address: string; recoveryKey: string }>;
export declare function encodeBundle(bundle: SealedBundle): string;
export declare function decodeBundle(text: string): SealedBundle;
/** Client side: the data key from the passphrase. Send only this to unlock. */
export declare function deriveDataKey(bundleOrSeal: SealedBundle | object, passphrase: string): Promise<Uint8Array>;

export declare class X402LockedError extends Error {
  code: 'locked';
  status: 423;
}

export interface PayerStatus {
  site: string;
  address: string;
  unlocked: boolean;
  expiresAt: string | null;
}

export interface SealedPayer {
  readonly address: string;
  readonly locked: boolean;
  /** Pays while unlocked; while locked it is the plain fetch and logs one [alert] line per lock. */
  fetch: typeof fetch;
  /** Throws X402LockedError while locked. */
  pay(url: string, options?: { offer?: object; init?: RequestInit }): Promise<PayResult>;
  status(): PayerStatus;
  unlock(dekBase64: string, ttl?: string): Promise<PayerStatus>;
  lock(dekBase64: string): Promise<PayerStatus>;
  /** Loopback operator control server: GET / (status + seal), POST /unlock {dek, ttl}, POST /lock {dek}. */
  listen(options?: { port?: number; host?: string }): Promise<import('node:http').Server>;
  lockNow(): void;
}

export declare function createSealedPayer(options: {
  site: string;
  sealed: string;
  clientOptions?: Omit<ClientOptions, 'key' | 'wallet'>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
}): SealedPayer;

export interface EnvPayer {
  kind: 'sealed' | 'plaintext';
  fetch: typeof fetch;
  address: string;
  status(): PayerStatus & { plaintext?: boolean };
  payer?: SealedPayer;
}

/**
 * X402_SEALED_KEY (+ X402_UNLOCK_PORT) -> sealed payer; else X402_PRIVATE_KEY unless
 * X402_LEGACY_PLAINTEXT_KEY=off -> plaintext payer with a [warn] line; else null.
 */
export declare function payerFromEnv(options: {
  site: string;
  env?: Record<string, string | undefined>;
  clientOptions?: Omit<ClientOptions, 'key' | 'wallet'>;
  log?: (line: string) => void;
  host?: string;
}): EnvPayer | null;
