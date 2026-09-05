/**
 * EIP-3009 `TransferWithAuthorization`.
 *
 * This — not a bespoke `Payment` struct — is what x402's `exact` scheme signs
 * on EVM. Whoever holds the signature can call `transferWithAuthorization` on
 * the token and move the funds, which is why the facilitator can broadcast
 * and pay the gas while the payer needs no native currency at all.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
