import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addressOfPublicKey,
  bytesToHex,
  checksumAddress,
  eip712Digest,
  encodeType,
  hashStruct,
  hexToBytes,
  recoverTypedDataSigner,
  signTypedData,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  walletFromKey,
} from '../src/index.js';
import { ADDRESS_ONE, KEY_ONE, PAY_TO, USDC_BASE } from './helpers.js';

/**
 * Produced by CoinPay Wallet's signer (`packages/extension/src/core/eip712.ts`,
 * itself checked byte for byte against ethers) over this exact domain and
 * message, with this exact key. If this port ever encodes differently, the
 * digest moves and this test says so before a wallet finds out on chain.
 */
const PARITY = {
  key: '0x030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc',
  digest: '0x205a9129e967e3c6d3818497932569c8a29256567b738d580434e06b4940a37d',
  signature:
    '0xc4c280a0eeca9f2bcd51a45180f9929c1cd1c041e7a466af7bae230ebd42b62151c4784a25a09ab40f4da32c485829004b27e6f5a81b11fa06fc018d194936e31c',
};

const DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
const MESSAGE = {
  from: '0x1111111111111111111111111111111111111111',
  to: PAY_TO,
  value: '1000000',
  validAfter: '0',
  validBefore: '1800000000',
  nonce: `0x${'42'.repeat(32)}`,
};

test('the digest and signature match CoinPay Wallet’s signer byte for byte', () => {
  const digest = eip712Digest(DOMAIN, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', MESSAGE);
  assert.equal(bytesToHex(digest), PARITY.digest);

  const signature = signTypedData(DOMAIN, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', MESSAGE, hexToBytes(PARITY.key));
  assert.equal(signature, PARITY.signature);
});

test('v is 27 or 28, and the signer recovers', () => {
  const v = hexToBytes(PARITY.signature)[64];
  assert.ok(v === 27 || v === 28, `v was ${v}`);

  const expected = walletFromKey(PARITY.key).address;
  const recovered = recoverTypedDataSigner(DOMAIN, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', MESSAGE, PARITY.signature);
  assert.equal(recovered, expected);

  // A raw recovery bit is accepted on the way in, since some tooling emits it.
  const raw = hexToBytes(PARITY.signature);
  raw[64] -= 27;
  assert.equal(recoverTypedDataSigner(DOMAIN, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', MESSAGE, bytesToHex(raw)), expected);
});

test('a changed field changes the digest', () => {
  const base = bytesToHex(eip712Digest(DOMAIN, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', MESSAGE));
  const more = bytesToHex(eip712Digest(DOMAIN, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', { ...MESSAGE, value: '1000001' }));
  const other = bytesToHex(eip712Digest({ ...DOMAIN, chainId: 137 }, TRANSFER_WITH_AUTHORIZATION_TYPES, 'TransferWithAuthorization', MESSAGE));
  assert.notEqual(base, more);
  assert.notEqual(base, other);
});

test('the well-known key derives the well-known address', () => {
  assert.equal(walletFromKey(KEY_ONE).address, ADDRESS_ONE);
  assert.equal(walletFromKey(KEY_ONE.slice(2)).address, ADDRESS_ONE, 'with or without 0x');
  assert.throws(() => walletFromKey('0x1234'), /32 bytes/);
  assert.throws(() => walletFromKey(`0x${'0'.repeat(64)}`), /valid/);
});

test('EIP-55 checksums', () => {
  assert.equal(checksumAddress('0xcc3b072391ae7a8d10cf00ddc5f61db2ca5541e5'), PAY_TO);
  assert.equal(checksumAddress(PAY_TO.toUpperCase().replace('0X', '0x')), PAY_TO);
  assert.equal(checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.throws(() => checksumAddress('0x12'));
});

test('the type string is canonical', () => {
  assert.equal(
    encodeType('TransferWithAuthorization', TRANSFER_WITH_AUTHORIZATION_TYPES),
    'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
  );
});

test('shapes that would encode wrongly are refused rather than signed', () => {
  const types = { Thing: [{ name: 'items', type: 'uint256[]' }] };
  assert.throws(() => hashStruct('Thing', types, { items: [1] }), /Unsupported EIP-712 type/);
  const nested = { Outer: [{ name: 'inner', type: 'Inner' }], Inner: [{ name: 'x', type: 'uint256' }] };
  assert.throws(() => hashStruct('Outer', nested, { inner: { x: 1 } }), /Unsupported EIP-712 type/);
  assert.throws(() => hashStruct('TransferWithAuthorization', TRANSFER_WITH_AUTHORIZATION_TYPES, { ...MESSAGE, nonce: '0x1234' }), /bytes32 must be 32 bytes/);
  assert.throws(() => hashStruct('TransferWithAuthorization', TRANSFER_WITH_AUTHORIZATION_TYPES, { ...MESSAGE, value: '-1' }), /Negative/);
  assert.throws(() => hashStruct('TransferWithAuthorization', TRANSFER_WITH_AUTHORIZATION_TYPES, { ...MESSAGE, to: '0x1234' }), /20 bytes/);
});

test('a public key, compressed or not, gives the same address', () => {
  const uncompressed = hexToBytes(
    '0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
  );
  const compressed = hexToBytes('0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.equal(addressOfPublicKey(uncompressed), ADDRESS_ONE);
  assert.equal(addressOfPublicKey(compressed), ADDRESS_ONE);
});
