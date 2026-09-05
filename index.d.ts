export interface TypedDataField {
  name: string;
  type: string;
}
export type TypedDataTypes = Record<string, TypedDataField[]>;
export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number | bigint | string;
  verifyingContract?: string;
  salt?: string;
}

export interface Wallet {
  /** EIP-55 checksummed address. */
  readonly address: string;
  signTypedData(domain: TypedDataDomain, types: TypedDataTypes, primaryType: string, message: Record<string, unknown>): string;
}

/** One option in a 402's `accepts`. */
export interface AcceptEntry {
  scheme?: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface Offer {
  x402Version?: number;
  accepts: AcceptEntry[];
  [k: string]: unknown;
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface Payment {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: string; authorization: Authorization };
}

export interface StoredPass {
  token: string;
  header: string;
  expires: string | null;
  boughtAt: string;
  url: string | null;
}

export interface PassStore {
  get(origin: string): StoredPass | null;
  set(origin: string, pass: StoredPass): void;
  delete(origin: string): void;
  all(): Record<string, StoredPass>;
  path?: string;
}

export interface Receipt {
  pass: string | null;
  header: string;
  expires: string | null;
  settlement: object | null;
}

export interface PayResult {
  status: number;
  body: unknown;
  receipt: Receipt;
  payer: string;
  network: string;
  amount: string;
  amountUsd: number | null;
  payTo: string | undefined;
  nonce: string;
  payment: Payment;
}

export interface ClientOptions {
  /** 32-byte secp256k1 private key, hex. */
  key?: string | Uint8Array;
  /** A wallet, instead of a key. */
  wallet?: Wallet;
  /** Only pay on these CAIP-2 networks, in the server's order of preference. */
  networks?: string[];
  /** Refuse any single payment above this many dollars. Default 5. */
  maxUsd?: number;
  /** How long a signed authorization stays valid; defaults to the offer's maxTimeoutSeconds, else 600. */
  validForSeconds?: number;
  /** A User-Agent to send when the caller sets none. */
  userAgent?: string;
  /** Where passes are filed: a store, or 'file' for the default file. Default memory. */
  store?: PassStore | 'file';
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
}

export interface X402Client {
  /** The paying address, or null for a client without a key. */
  readonly address: string | null;
  readonly store: PassStore;
  /** fetch that presents a filed pass and pays a 402 once. */
  fetch(input: string | URL | Request, init?: RequestInit, options?: { pay?: boolean }): Promise<Response>;
  /** Pay for a URL (asking it for the offer first unless one is given) and file any pass. */
  pay(url: string | URL | Request, options?: { offer?: Offer; init?: RequestInit }): Promise<PayResult>;
  /** The live pass filed for a URL's origin. */
  passFor(url: string | URL): StoredPass | null;
}

export type X402ErrorCode = 'no-key' | 'no-offer' | 'no-option' | 'too-expensive' | 'rejected';

export class X402Error extends Error {
  code: X402ErrorCode | string;
  status: number | null;
  body: unknown;
  offer: Offer | null;
  url: string | null;
}

export const DEFAULT_MAX_USD: number;
export const X402_VERSION: number;
export const KNOWN_TOKEN_DOMAINS: Record<string, { name: string; version: string; decimals: number }>;
export const TRANSFER_WITH_AUTHORIZATION_TYPES: TypedDataTypes;

export function createClient(options?: ClientOptions): X402Client;
export function walletFromKey(privateKey: string | Uint8Array): Wallet;
export function randomWallet(): { wallet: Wallet; privateKey: string };

export function memoryStore(): PassStore;
export function fileStore(path?: string): PassStore;
export function defaultPassPath(): string;
export function originOf(url: string | URL): string;
export function isLive(pass: StoredPass | null | undefined, now?: number): boolean;

export function evmChainId(network: string): number | null;
export function readOffer(response: Response): Promise<{ offer: Offer | null; body: unknown }>;
export function isOffer(value: unknown): value is Offer;
export function selectAccept(accepts: AcceptEntry[], options?: { networks?: string[] }): AcceptEntry | null;
export function domainFor(entry: AcceptEntry): { name: string; version: string; chainId: number; verifyingContract: string };
export function requiredAmount(entry: AcceptEntry): string;
export function amountUsd(entry: AcceptEntry): number | null;
export function randomNonce(): string;
export function buildAuthorization(args: {
  from: string;
  to: string;
  value: string | number | bigint;
  validForSeconds?: number;
  nonce?: string;
  now?: number;
}): Authorization;
export function signPayment(
  entry: AcceptEntry,
  wallet: Wallet,
  options?: { validForSeconds?: number; nonce?: string; now?: number },
): { payment: Payment; header: string; authorization: Authorization; domain: TypedDataDomain };
export function encodePaymentHeader(payment: Payment): string;
export function decodePaymentHeader(header: string | null | undefined): Payment | null;
export function readReceipt(response: Response, body: unknown): Receipt;

export function eip712Digest(domain: TypedDataDomain, types: TypedDataTypes, primaryType: string, message: Record<string, unknown>): Uint8Array;
export function signTypedData(
  domain: TypedDataDomain,
  types: TypedDataTypes,
  primaryType: string,
  message: Record<string, unknown>,
  privateKey: Uint8Array,
): string;
export function recoverTypedDataSigner(
  domain: TypedDataDomain,
  types: TypedDataTypes,
  primaryType: string,
  message: Record<string, unknown>,
  signature: string,
): string;
export function addressOfPublicKey(publicKey: Uint8Array): string;
export function checksumAddress(address: string): string;
export function hashStruct(primaryType: string, types: TypedDataTypes, data: Record<string, unknown>): Uint8Array;
export function hashDomain(domain: TypedDataDomain): Uint8Array;
export function encodeType(primaryType: string, types: TypedDataTypes): string;
export function typeHash(primaryType: string, types: TypedDataTypes): Uint8Array;
export function hexToBytes(hex: string): Uint8Array;
export function bytesToHex(bytes: Uint8Array): string;
