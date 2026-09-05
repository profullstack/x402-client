/**
 * A wallet is a private key and the address it controls.
 *
 * That is all an x402 payer needs: the `exact` scheme moves USDC with an
 * EIP-3009 authorization that the facilitator broadcasts and pays the gas
 * for, so the key never sends a transaction and never holds ETH. It signs
 * typed data, and it does so offline.
 *
 * The key is held as bytes for the life of the wallet and never logged,
 * serialized or returned. Anything that needs to identify the wallet uses
 * the address.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';

import { addressOfPublicKey, hexToBytes, signTypedData } from './eip712.js';

/**
 * @typedef {{
 *   address: string,
 *   signTypedData: (domain: object, types: object, primaryType: string, message: object) => string,
 * }} Wallet
 */

/**
 * A wallet from a 32-byte secp256k1 private key, hex with or without `0x`.
 *
 * @param {string|Uint8Array} privateKey
 * @returns {Wallet}
 */
export function walletFromKey(privateKey) {
  const key = typeof privateKey === 'string' ? hexToBytes(privateKey.trim()) : privateKey;
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error('A private key is 32 bytes (64 hex characters)');
  }
  if (!secp256k1.utils.isValidSecretKey(key)) throw new Error('Not a valid secp256k1 private key');

  const address = addressOfPublicKey(secp256k1.getPublicKey(key, false));

  return Object.freeze({
    address,
    signTypedData: (domain, types, primaryType, message) => signTypedData(domain, types, primaryType, message, key),
  });
}

/**
 * A fresh random wallet, for tests and for a first run with nothing funded.
 *
 * Returns the key as well, since a wallet that cannot be saved cannot be
 * funded: the caller stores it and never sees it here again.
 *
 * @returns {{ wallet: Wallet, privateKey: string }}
 */
export function randomWallet() {
  const key = secp256k1.utils.randomSecretKey();
  let hex = '0x';
  for (const b of key) hex += b.toString(16).padStart(2, '0');
  return { wallet: walletFromKey(key), privateKey: hex };
}
