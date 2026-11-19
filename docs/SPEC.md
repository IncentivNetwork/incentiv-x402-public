# x402 on Incentiv: protocol specification

This document specifies two x402 v2 payment schemes for Incentiv mainnet, `incentiv-eoa-tx` and `incentiv-userop`, and the facilitator that verifies and settles them. It follows the x402 v2 specification (`x402-foundation/x402`): the `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers, `PaymentRequirements`, `PaymentPayload`, and the facilitator's `/verify`, `/settle` and `/supported` endpoints. Only what is specific to Incentiv is described here.

## 1. Network and contracts

| Item | Value |
| --- | --- |
| Network | `eip155:24101` |
| Asset | USDC `0x16e43840d8D79896A389a3De85aB0B0210C05685`, 6 decimals |
| EntryPoint (ERC-4337 v0.7) | `0x3eC61c5633BBD7Afa9144C6610930489736a72d4` |
| Account factory | `0xfED842F3C1d054361A840AE863C0b72db5CB2a32` |
| Unified Token Paymaster | `0x43000f785EB43BcB4961C5c70276eD00e088972c` |
| TransferGate | `0x66F51d740d0Ab781bc525B52d0d35D0585086Aa1` |

## 2. Rules common to both schemes

### 2.1 PaymentRequirements

| Field | Rule |
| --- | --- |
| `scheme` | `incentiv-eoa-tx` or `incentiv-userop` |
| `network` | `eip155:24101` |
| `asset` | The USDC address above |
| `amount` | Atomic units. The payment must equal it exactly. |
| `payTo` | The recipient address |
| `maxTimeoutSeconds` | Capped at 300 by the resource server; 120 is recommended |
| `extra` | Scheme-specific (sections 3.1 and 4.1) |

### 2.2 Deadline

The payer chooses a deadline `validUntil` (Unix seconds), normally signing time plus `maxTimeoutSeconds`, and binds it into what it signs (sections 3.3 and 4.3). The facilitator refuses a payment when `validUntil ≤ now` (`payment_expired`). It also refuses one when `validUntil > now + min(maxTimeoutSeconds, 300) + 5`, which is `invalid_payment_requirements`; the 5 seconds allow for clock skew.

The chain does not enforce the deadline. A signed payment that is never settled remains valid on chain until its nonce is used. Section 6 describes cancellation.

### 2.3 One settlement, one claimant

A payment is reported as a success to at most one `/settle` call. A later or concurrent `/settle` for the same payment answers `success: false` with `already_settled` or `already_settling`. This stops one payment from serving several requests that carry the same payload. A settle that ended in `settle_timeout` is not final: retrying the same payload resolves it.

### 2.4 Order of operations

The facilitator answers `/verify` without changing any state. `/settle` repeats every check before submitting, because balances, nonces and TransferGate state can change between the two calls. A resource server serves the content only after `/settle` reports `success: true`.

## 3. Scheme `incentiv-eoa-tx`

The payer is an externally owned account. It pays with a signed EIP-1559 transaction that transfers USDC, and pays the gas in CENT.

### 3.1 PaymentRequirements

`extra` is `{}`.

### 3.2 Payload

```json
{ "signedTransaction": "0x02…" }
```

### 3.3 The transaction

1. It is a type-2 (EIP-1559) transaction in canonical encoding, with `chainId` 24101, `to` = `asset` and `value` 0.
2. `data` is `transfer(payTo, amount)` in canonical ABI encoding.
3. `gas` is at most 120,000.
4. `accessList` holds exactly one entry with no storage keys: the deadline marker. Its address is the bytes `78343032` ("x402"), then `validUntil` as a big-endian `uint64`, then 8 zero bytes. Because the access list is signed, so is the deadline.
5. `nonce` is the sender's next transaction nonce.

The payer is the address recovered from the signature.

### 3.4 Verification

Checks run in this order and stop at the first failure.

| # | Check | Reason |
| --- | --- | --- |
| 1 | `x402Version` is 2; `scheme` and `network` match; `accepted.asset`, `accepted.payTo` and `accepted.amount` equal the requirements | `invalid_x402_version`, `invalid_scheme`, `invalid_network`, `invalid_payment_requirements` |
| 2 | The transaction has the shape in 3.3; a sender is recovered | `invalid_payload`, `invalid_signature` |
| 3 | The deadline (2.2) | `payment_expired`, `invalid_payment_requirements` |
| 4 | The transfer pays exactly `amount` of `asset` to `payTo` | `asset_mismatch`, `payto_mismatch`, `amount_mismatch` |
| 5 | The transaction hash was not already settled | `already_settled` |
| 6 | No other payment from this sender is being settled | `payer_busy` |
| 7 | `nonce` equals the sender's confirmed transaction count | `nonce_used` |
| 8 | The sender's USDC covers `amount`, and its CENT covers `gas × maxFeePerGas` | `insufficient_funds` |
| 9 | An `eth_call` of the transfer from the sender succeeds | `simulation_failed` |
| 10 | `TransferGate.checkApproval` approves the transfer, called from the sender | `transfer_gate_pending`, `transfer_gate_blocked`, `transfer_gate_unavailable` |

### 3.5 Settlement

1. If the transaction already has a receipt, report its outcome.
2. Otherwise mark the sender busy, repeat checks 7 to 10, and submit it with `eth_sendRawTransaction`.
3. Wait up to 60 seconds for a receipt.

| Outcome | Response |
| --- | --- |
| Receipt with status success | `success: true`, `transaction` = the transaction hash, `payer`, `amount` |
| Receipt with status reverted | `success: false`, `tx_reverted` |
| The RPC rejects the transaction | `success: false`, `tx_rejected` |
| No receipt within 60 seconds | `success: false`, `settle_timeout` |

## 4. Scheme `incentiv-userop`

The payer is an Incentiv smart account controlled by an owner EOA. It pays with a signed ERC-4337 user operation, which the facilitator submits through the bundler.

### 4.1 PaymentRequirements

`extra.entryPoint` is the EntryPoint address in section 1.

### 4.2 Payload

```json
{
  "userOperation": { "sender": "0x…", "nonce": "0x…", "callData": "0x…", "…": "unpacked v0.7 fields, hex strings" },
  "userOpHash": "0x…",
  "paymentId": "0x<32 bytes>",
  "validUntil": 1763300000
}
```

`factory` and `factoryData` are present only on an account's first operation. The `paymaster*` fields are present only when gas is paid through the paymaster.

### 4.3 The user operation

1. **Calls.** `callData` is the account's `executeBatch(dest[], value[], func[])` in canonical encoding. It holds exactly one of these two forms:
   - with the paymaster: `asset.transfer(paymaster, fee)`, then `asset.transfer(payTo, amount)`; `paymasterData` is empty;
   - without a paymaster: `asset.transfer(payTo, amount)` only, with gas paid in CENT from the account's EntryPoint deposit and balance.

   Every `value` is 0. Each transfer uses canonical ABI encoding.
2. **Nonce lane.** The nonce key (its upper 192 bits) is the top 192 bits of `keccak256(abi.encode(bytes32 paymentId, uint64 validUntil))`. The sequence is the account's current one on that key. Each payment therefore has its own lane, and the signature, which covers the nonce, also covers the deadline. Two operations with the same `paymentId` and `validUntil` share a nonce, so at most one executes.
3. **Signature.** It is the owner's ECDSA signature over the EIP-191 message hash of `userOpHash`.
4. **First payment.** An account that is not deployed yet is deployed by its first payment. `factoryData` must be `createAccount(owner, [0, 0], salt)` on the factory, the factory's `getAddress` for those arguments must equal `sender`, and the signature must recover `owner`.

### 4.4 Verification

| # | Check | Reason |
| --- | --- | --- |
| 1 | `x402Version` is 2; `scheme` and `network` match; `accepted` matches the requirements; `extra.entryPoint` is the EntryPoint | `invalid_x402_version`, `invalid_scheme`, `invalid_network`, `invalid_payment_requirements` |
| 2 | The payload's fields are well formed | `invalid_payload` |
| 3 | The deadline (2.2) | `payment_expired`, `invalid_payment_requirements` |
| 4 | `userOpHash` equals the EntryPoint v0.7 hash of `userOperation` | `invalid_payload` |
| 5 | The calls have one of the forms in 4.3 and pay exactly `amount` of `asset` to `payTo` | `invalid_payload`, `asset_mismatch`, `payto_mismatch`, `amount_mismatch` |
| 6 | The nonce key is the lane derived from `paymentId` and `validUntil` | `invalid_payload` |
| 7 | The operation was not already settled | `already_settled` |
| 8 | The nonce equals `EntryPoint.getNonce(sender, key)` | `nonce_used` |
| 9 | For a deployed account, `isValidSignature(userOpHash, signature)` returns `0x1626ba7e`; for an undeployed one, the rules in 4.3 item 4 hold | `invalid_signature` |
| 10 | Without a paymaster, the account's EntryPoint deposit plus balance covers all gas limits at `maxFeePerGas` | `insufficient_funds` |
| 11 | The account's USDC covers `amount` plus the paymaster fee | `insufficient_funds` |
| 12 | `TransferGate.checkApproval` approves every call, called from the account | `transfer_gate_pending`, `transfer_gate_blocked`, `transfer_gate_unavailable` |
| 13 | The bundler simulates it (`eth_estimateUserOperationGas`) | `simulation_failed` |

### 4.5 Settlement

1. If the operation already has a receipt, report its outcome.
2. Otherwise repeat checks 8 to 13 and submit it with `eth_sendUserOperation`.
3. Wait up to 60 seconds for `eth_getUserOperationReceipt`. Inclusion alone is not success: the receipt's `success` must be true.

| Outcome | Response |
| --- | --- |
| Receipt with `success: true` | `success: true`, `transaction` = the bundle transaction hash, `payer` = the account, `amount` |
| Receipt with `success: false` | `success: false`, `userop_reverted` |
| The bundler rejects the operation | `success: false`, `userop_rejected` |
| No receipt within 60 seconds | `success: false`, `settle_timeout` |

## 5. Facilitator HTTP API

| Method and path | Body or query | Response |
| --- | --- | --- |
| `GET /supported` | | `{ kinds: [{ x402Version: 2, scheme, network: "eip155:24101" }, …], extensions: ["bazaar"], signers: { "eip155:24101": [] } }` (the facilitator holds no signing key) |
| `POST /verify` | `{ x402Version: 2, paymentPayload, paymentRequirements }` | `{ isValid, invalidReason?, invalidMessage?, payer? }` |
| `POST /settle` | The same as `/verify` | `{ success, errorReason?, errorMessage?, payer?, transaction, network, amount? }` |
| `GET /health` | | `200 { status: "ok", rpc, bundler }`, or `503` when the RPC or the bundler is down |
| `GET /discovery/resources` | `type`, `payTo`, `scheme`, `network`, `limit` (≤ 100), `offset` | `{ x402Version: 2, items, pagination: { limit, offset, total } }` |
| `GET /discovery/search` | `query`, plus the same filters and `limit` | `{ x402Version: 2, resources, partialResults, pagination: null }` |

- `/verify` and `/settle` answer HTTP 200 for every payment outcome.
  - A request without `paymentPayload` or `paymentRequirements` answers 400.
  - A client over the rate limit answers 429. The defaults are 120 `/verify` and 60 `/settle` calls per minute per address.
- **Discovery.** A resource is cataloged when a payment for it settles successfully and its payload carries the Bazaar extension. The `/settle` response then carries the `EXTENSION-RESPONSES` header: base64 JSON of `{ "bazaar": { "status": "success" | "rejected", "rejectedReason"? } }`.

## 6. Cancellation

A payer can make an unsettled payment unusable before its deadline passes:

- `incentiv-eoa-tx`: send a zero-value transaction to yourself with the same nonce and a higher fee.
- `incentiv-userop`: submit any operation on the payment's nonce lane, for example an empty `executeBatch`, so that the lane's nonce moves past the payment.

## 7. Reason codes

| Code | Meaning |
| --- | --- |
| `invalid_x402_version` | Not x402 v2 |
| `invalid_scheme`, `invalid_network` | Wrong scheme or network |
| `invalid_payment_requirements` | `accepted` differs from the requirements, an unexpected EntryPoint, or a deadline beyond the allowed window |
| `invalid_payload` | Malformed or non-canonical payload, or calls other than the allowed forms |
| `invalid_signature` | The signature does not authorize this payment |
| `payment_expired` | `validUntil` has passed |
| `asset_mismatch`, `payto_mismatch`, `amount_mismatch` | The payment is not the one quoted |
| `nonce_used` | The nonce has moved on; the payment was used or cancelled |
| `payer_busy` | Another payment from the same EOA is being settled |
| `insufficient_funds` | Not enough USDC for the payment, or not enough CENT or USDC for gas |
| `transfer_gate_pending`, `transfer_gate_blocked`, `transfer_gate_unavailable` | TransferGate would escrow or block the transfer, or could not be read |
| `simulation_failed` | The transfer or the operation fails in simulation |
| `already_settled`, `already_settling` | The payment was already reported to another request (2.3) |
| `settle_timeout` | Submitted, but no receipt within 60 seconds; retry the same payload |
| `tx_rejected`, `tx_reverted` | The RPC rejected the transaction, or it reverted |
| `userop_rejected`, `userop_reverted` | The bundler rejected the operation, or it reverted |
| `unexpected_verify_error`, `unexpected_settle_error` | An internal error |

## 8. Security considerations

- **Verify before signing.** Clients must decode what they are about to sign, because `userOpHash` is opaque. The reference clients refuse anything that is not exactly the quoted payment.
- **No facilitator key.** The facilitator holds no private key. It cannot move funds beyond what payers signed.
- **Compliance.** TransferGate is checked at `/verify` and `/settle`. For `incentiv-userop` it is also enforced on chain, inside the account.
- **Single instance.** The single-claimant guarantee (2.3) and `payer_busy` rely on facilitator memory. A facilitator must run as one instance.
- **Untrusted text.** The free text in `PAYMENT-REQUIRED` (`description`, `extra`, `error`) is written by the merchant, and agents must treat it as untrusted.

## 9. Why not `exact`

The standard `exact` scheme needs EIP-3009 on the token, or a deployed Permit2 and the x402 Permit2 proxy.

- **EIP-3009:** USDC on Incentiv implements neither EIP-3009 nor EIP-2612.
- **Permit2:** the proxy's published bytecode uses `MCOPY`, which Incentiv's EVM does not support. A Permit2 pull would also move funds outside the smart account's TransferGate check.

The two schemes here keep every payment a direct transfer by the payer.
