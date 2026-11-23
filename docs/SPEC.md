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
| `asset` | The USDC address above. Any other asset is `asset_mismatch`. |
| `amount` | Atomic units, at least 1. The payment must equal it exactly. Anything else is `invalid_payment_requirements`. |
| `payTo` | The recipient address |
| `maxTimeoutSeconds` | A positive integer, capped at 300; 120 is recommended. Anything else is `invalid_payment_requirements`. |
| `extra` | Scheme-specific (sections 3.1 and 4.1) |

### 2.2 Deadline

The payer chooses a deadline `validUntil` (Unix seconds), normally signing time plus `maxTimeoutSeconds`, and binds it into what it signs (sections 3.3 and 4.3). The facilitator refuses a payment when `validUntil ≤ now` (`payment_expired`). It also refuses one when `validUntil > now + min(maxTimeoutSeconds, 300) + 5`, which is `invalid_payment_requirements`; the 5 seconds allow for clock skew.

The chain does not enforce the deadline. A signed payment that is never settled remains valid on chain until its nonce is used. Section 6 describes cancellation.

### 2.3 One settlement, one claimant

A payment is reported as a success to at most one `/settle` call. A later or concurrent `/settle` for the same payment answers `success: false` with `already_settled` or `already_settling`. This stops one payment from serving several requests that carry the same payload.

Just before submitting a payment, the facilitator records a **claim** for it in durable storage. A receipt found on chain is reported as a success only when the facilitator holds the claim. Without a claim, the payment was submitted by someone else or its record was lost, and the answer is `already_settled`.

A settle that ended in `settle_timeout` is not final: retrying the same payload resolves it, even after the deadline, because the receipt is looked up before the deadline is checked. If the retry finds no receipt but the facilitator holds the claim and the payment's nonce is used (the chain checks answer `nonce_used`), the payment may have landed without being visible to the receipt lookup yet. The same holds for `payment_expired` while the payment may still land, because the facilitator enforces the deadline and the chain does not: it is final only when the chain shows the nonce unused (for an EOA transfer, pending transactions included) and, for a user operation, the bundler does not hold it. The facilitator then waits for the receipt for the settle window instead, and without one answers `settle_timeout`, because a later retry can still find it. (A payer who spent the nonce on another transaction therefore costs the merchant retries until the claim expires after 1 hour.)

The claim is released only when the RPC or bundler definitely refused the payment **and** the chain shows neither a receipt for the payment nor its nonce used (for an EOA transfer, counting the node's pending transactions; for a user operation, the bundler must not report it either, queued or included, through `eth_getUserOperationByHash`, where only an explicit `null` result means it does not; when the lookup gives no such answer (an error, a bundler without the method, an answer without a result) and an earlier settle already submitted the operation, the claim is kept, since that copy may still be queued). A definite refusal is a JSON-RPC error other than an internal error (`-32603`) sent with a 2xx or 4xx status other than 408, or an HTTP 4xx status other than 408; a 408 or 5xx status is never a refusal, whatever its body says. From the RPC, answers about the node rather than the payment (HTTP 403, 408, 413, 429 and 5xx; JSON-RPC `-1`, `-32005`, `429` and `-32603`) are not refusals. A payment is sent once per settle, but a settle retried after `settle_timeout` sends it again, and that resend can be refused because the first copy landed or is still pending. So for an EOA transfer, a nonce refusal (`nonce too low` and similar wordings), or any refusal of a resend after an earlier settle submitted the payment, keeps the claim without relying on a read: behind a load-balanced RPC, the receipt and nonce reads can reach a node that has not seen the payment yet. A payment kept this way that never lands is answered `payment_expired` once its deadline has passed and its nonce reads unused; if another transaction from the payer used the nonce, the answer stays `settle_timeout` until the claim expires after 1 hour. If the nonce is used without a receipt, the claim is kept, the receipt is awaited, and the answer without one is `settle_timeout`. If the submission got no answer (a lost connection, a timeout, a 5xx status or an internal error), the payment may have been accepted. The claim is kept, the facilitator waits for the receipt as usual, and a `settle_timeout` is retried with the same payload. If the payment did land, the retry reports it once. If it did not, the retry submits it again.

A settle has a single 60-second window for checks, submission and polling. If the checks run out of time, the facilitator answers `settle_timeout` before submitting. A submission that has not answered by the end of the window counts as no answer.

**Result persistence.** A confirmed execution without the required USDC log returns `payment_transfer_missing` even if the result cannot be recorded. The claim then keeps its original lifetime.

A success is reported only after it is durably recorded. If storage fails after the payment executed, the answer is `settle_unrecorded`; the claim is kept for 7 days (as long as a result) instead of 1 hour, and retrying the same payload reports the success once storage works. (A restart before storage works loses that extension, and the 1-hour claim limit applies again.) A failure that cannot be recorded (`tx_reverted`, `userop_reverted`) is answered as is and its claim keeps the 1-hour limit. Because the payment's nonce is used by then, `/verify` accepts a payload whose claim this facilitator holds and whose payment executed successfully, skipping the chain checks, and also one whose claim it holds and that may still land by the rules above (no receipt yet, and its nonce used, or its deadline passed without the payment shown absent); the settle that follows waits for the receipt and never submits it again, so a merchant that verifies before every settle can retry it too (the same applies after `settle_timeout`). If the claim itself cannot be recorded, the answer is `store_unavailable` and nothing is submitted.

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
5. `nonce` is the sender's next confirmed nonce. A payer with a pending transaction waits until it is mined; the reference client refuses to sign until then.

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

1. If the transaction already has a receipt, report its outcome when this facilitator holds the claim (2.3), and `already_settled` otherwise.
2. Otherwise mark the sender busy, check the deadline, repeat checks 7 to 10, record the claim, and submit it with `eth_sendRawTransaction`.
3. Wait for a receipt until 60 seconds after step 1 started.

| Outcome | Response |
| --- | --- |
| Successful receipt with a USDC `Transfer(payer, payTo, amount)` log | `success: true`, `transaction` = the transaction hash, `payer`, `amount` |
| Successful receipt without the exact USDC transfer log | `success: false`, `payment_transfer_missing` |
| Receipt with status reverted | `success: false`, `tx_reverted` |
| The RPC refuses the transaction (a JSON-RPC error, or a 4xx status, that is not transient; 2.3) on its first submission, not for its nonce, and the chain shows neither its receipt nor its nonce used, pending included | `success: false`, `tx_rejected`; the claim is released |
| The RPC refuses it, but its receipt exists | The receipt is reported as above |
| The RPC refuses it for its nonce, or refuses a resend after an earlier settle submitted it, or the sender's nonce is used or pending, without a receipt | The claim is kept and the receipt is awaited; without one, `settle_timeout` |
| No answer to the submission (2.3) | The claim is kept and the receipt is awaited as above |
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

1. If the operation already has a receipt, report its outcome when this facilitator holds the claim (2.3), and `already_settled` otherwise.
2. Otherwise check the deadline, repeat checks 8 to 13, record the claim, and submit it with `eth_sendUserOperation`.
3. Use `eth_getUserOperationReceipt` to locate the bundle, then read the transaction receipt from the chain RPC within 60 seconds after step 1 started. An operation receipt requires a matching EntryPoint `UserOperationEvent` in a successful bundle. The event's `success` determines whether the operation reverted. For success, the exact USDC `Transfer(payer, payTo, amount)` log must appear after the preceding EntryPoint `UserOperationEvent` (or `BeforeExecution` for the first operation) and before the operation's own event.

| Outcome | Response |
| --- | --- |
| Successful operation with the exact USDC transfer log in its execution | `success: true`, `transaction` = the bundle transaction hash, `payer` = the account, `amount` |
| Successful operation without the exact USDC transfer log | `success: false`, `payment_transfer_missing` |
| Receipt with `success: false` | `success: false`, `userop_reverted` |
| The bundler refuses the operation (a JSON-RPC error, with any HTTP status, or a 4xx status), does not hold it, and the chain shows neither its receipt nor its nonce used | `success: false`, `userop_rejected`; the claim is released |
| The bundler refuses it, but its receipt exists | The receipt is reported as above |
| The bundler refuses it, but still holds it (`eth_getUserOperationByHash`), or the account's nonce is used, without a receipt | The claim is kept and the receipt is awaited; without one, `settle_timeout` |
| No answer to the submission (2.3) | The claim is kept and the receipt is awaited as above |
| No receipt within 60 seconds | `success: false`, `settle_timeout` |
| Reverted bundle or no matching operation event | The facilitator keeps polling for a matching EntryPoint `UserOperationEvent` and answers `settle_timeout` if the window ends. Only a matching event with `success: false` establishes `userop_reverted` |
| The bundler locates a bundle before the chain RPC confirms the operation | With a prior claim, the facilitator checks recent bundle candidates until one is confirmed or the window ends with `settle_timeout`. Without a claim, it answers `already_settled` |
| The bundler returns an operation receipt without a bundle hash | The facilitator rechecks the lookup without creating a claim or resubmitting |

## 5. Facilitator HTTP API

| Method and path | Body or query | Response |
| --- | --- | --- |
| `GET /supported` | | `{ kinds: [{ x402Version: 2, scheme, network: "eip155:24101" }, …], extensions: ["bazaar"], signers: { "eip155:24101": [] } }` (the facilitator holds no signing key; `extensions` is empty with discovery off) |
| `POST /verify` | `{ x402Version: 2, paymentPayload, paymentRequirements }` | `{ isValid, invalidReason?, invalidMessage?, payer? }` |
| `POST /settle` | The same as `/verify` | `{ success, errorReason?, errorMessage?, payer?, transaction, network, amount? }` |
| `GET /health` | | `200 { status: "ok", rpc, bundler }`, or `503` when the RPC or the bundler is down |
| `GET /discovery/resources` (with discovery on) | `type`, `payTo`, `scheme`, `network`, `limit` (≤ 100), `offset` | `{ x402Version: 2, items, pagination: { limit, offset, total } }` |
| `GET /discovery/search` (with discovery on) | `query`, plus the same filters and `limit` | `{ x402Version: 2, resources, partialResults, pagination: null }` |

- `/verify` and `/settle` answer HTTP 200 for every payment outcome.
  - A request without `paymentPayload` or `paymentRequirements` answers 400 `invalid_request`. A scheme, network or x402 version the facilitator does not serve answers 400 `unsupported_scheme`.
  - The service answers 404 `not_found` for a path it does not serve. `createFacilitatorApp` used as a library leaves unknown paths to the app that uses it.
  - A client over the rate limit answers 429. The defaults are 120 `/verify`, 60 `/settle` and, with discovery on, 120 `/discovery/*` calls per minute per address.
- **Discovery (optional, off by default).** A facilitator offers discovery only when it is switched on. With it off, `/discovery/*` is not served (the service answers 404 `not_found`), `/supported` lists no `bazaar` extension, `/settle` sends no `EXTENSION-RESPONSES` header, and no catalog is kept. The rest of this item describes a facilitator with discovery on. A resource is cataloged when a payment for it settles successfully and its payload carries the Bazaar extension. Entries are keyed by method, resource, network and `payTo`, so a payment to another address creates a separate entry. Listings are not authenticated: the details of an entry (description, schema, listed price) come from whoever pays. Each version of those details is scored by the USDC paid for it, halving every 24 hours, and the best-scored version is served (a tie keeps the one served; self-payments score nothing). Versions are compared with object keys in a fixed order (every key counts, `__proto__` included) and addresses lowercased, so the same declaration with its keys reordered, or an address in another casing, is the same version; the served values are kept as paid. How a sale was paid (`scheme`, `extra` and `maxTimeoutSeconds`) is not part of a version, so a route that offers both schemes is one listing, even with a different timeout per scheme. Its `accepts` lists one item per scheme the version was paid with in the last 7 days, each with its own `extra` and timeout and the latest sale's first, so a `scheme` filter finds the route whichever scheme was used last; a scheme not paid for 7 days is dropped at the next sale. `extra` keeps only the fields a scheme defines (`entryPoint` for `incentiv-userop`). The listed price is part of a version, so a route whose price changes from request to request has competing versions, and the less paid prices are answered `rejected`. A dynamic route's `info.input.pathParams` hold one request's values and are not stored. A version first served without a counted payment (a self-payment, or a listing stored before scoring existed) starts at one sale at its listed price, and that floor decays like any score. A payment for another version, including the merchant's own changed price or description, is answered `rejected` (`another version of this listing has more recent payments`) and the old details stay listed until that version outscores the served one, so replacing a merchant's listing costs more than the route recently earned, paid to the merchant, and a merchant's own changed declaration takes over as its customers pay for it. Up to 2 competing versions are kept per entry, in memory only. Listings are not verified against the resource's live 402; clients pay what the live 402 asks. Only `http` resources are cataloged. The extension's `info` is checked against the Bazaar shape, but its JSON `schema` is never compiled by the facilitator, because it comes from the payer. A schema that uses `pattern` or `patternProperties` in a schema position, uses references (`$ref`, `$id`, `$anchor` or their dynamic and recursive forms; a chain of references can be exponential for a validator), or is nested more than 32 levels deep, is rejected, because the catalog serves it and the Bazaar SDK compiles it by default; consumers should still not compile a served schema with untrusted regular expressions enabled. A `description` loses line breaks and tabs, and is dropped if it holds other control characters, bidirectional overrides or zero-width characters; a `mimeType` must be a plain `type/subtype` with optional parameters. The extension is at most 4,096 characters as JSON, and a whole entry, including the listed payment requirements (only their standard fields are kept), at most 8,192. A `payTo` has at most 50 entries and the catalog at most 2,000. When a `payTo` or the catalog is full, a new entry replaces the weakest one (the least recently paid among equals) only if it is stronger, or if the weakest has not been paid for 7 days; a tie keeps the existing entry. Self-payments (payer equals `payTo`) never add strength. Within a `payTo`, strength is the USDC paid to that `payTo` for the entry, with no cap: a new route gets in once its customers have paid more for it than was paid for the weakest listing, so pushing out a merchant's routes costs more than they earn, paid to the merchant. Across the catalog, strength is the payer count, each payer adding at most 4, for up to 32 payers (128 at most), because payments between addresses one party controls cost that party nothing. A rejected entry's strength is kept in memory only, for 7 days after its last payment: at most 50 per `payTo` (the least paid forgotten first) and 2,000 in all (beyond that, the `payTo`s with the most give up their least paid entry, the least recently paid among equals). A refusal that adds no strength, such as a self-payment, is not remembered. So is the score of each version it was paid with (at most 3). A refused entry is admitted only by a payment for its strongest version, the rule a listed entry follows: a payment for a weaker version adds to the entry's strength but is answered `rejected`, and nothing is pushed out for it. The admitted version starts with what it was paid while it waited, and the other versions keep competing with what they earned. An update by another payer keeps the entry's strength and adds that payment to it. An entry not paid for 30 days is dropped, whether or not the catalog is full. Entries saved by an earlier version are checked against the same rules on load; a date in the future is set to the load time, and a catalog file that cannot be read is moved to `catalog.json.corrupt-<time>` and the catalog starts empty. A search query is at most 200 characters and 10 words. A catalog failure never changes the settle result. The `/settle` response then carries the `EXTENSION-RESPONSES` header: base64 JSON of `{ "bazaar": { "status": "success" | "rejected", "rejectedReason"? } }`, where `rejectedReason` is a short fixed string; details go to the facilitator's log.

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
| `nonce_used` | The nonce has moved on; the payment was used or cancelled. `/settle` never answers it while the facilitator holds the payment's claim (2.3); `/verify` can |
| `payer_busy` | Another payment from the same EOA is being settled |
| `insufficient_funds` | Not enough USDC for the payment, or not enough CENT or USDC for gas |
| `transfer_gate_pending`, `transfer_gate_blocked`, `transfer_gate_unavailable` | TransferGate would escrow or block the transfer, or could not be read |
| `simulation_failed` | The transfer or the operation fails in simulation |
| `already_settled`, `already_settling` | The payment was already reported to another request (2.3) |
| `settle_timeout` | No receipt within 60 seconds (the payment may have been submitted), or the checks did not finish in time (nothing was submitted); retry the same payload |
| `tx_rejected`, `tx_reverted` | The RPC rejected the transaction, or it reverted |
| `userop_rejected`, `userop_reverted` | The bundler rejected the operation, or it reverted |
| `payment_transfer_missing` | The receipt does not prove the exact USDC transfer for this payment |
| `settle_unrecorded` | The payment executed but could not be recorded; retry the same payload (2.3) |
| `store_unavailable` | The facilitator cannot record claims; nothing was submitted |
| `unexpected_verify_error`, `unexpected_settle_error` | An internal error |

## 8. Security considerations

- **Verify before signing.** Clients must decode what they are about to sign, because `userOpHash` is opaque. The reference clients refuse anything that is not exactly the quoted payment.
- **No facilitator key.** The facilitator holds no private key. It cannot move funds beyond what payers signed.
- **Compliance.** TransferGate is checked at `/verify` and `/settle`. For `incentiv-userop` it is also enforced on chain, inside the account.
- **Single instance, durable storage.** `payer_busy` and in-flight tracking rely on facilitator memory, and claims (2.3) on its storage. A facilitator must run as one instance with persistent storage.
- **Untrusted text.** The free text in `PAYMENT-REQUIRED` (`description`, `extra`, `error`) is written by the merchant, and agents must treat it as untrusted.

## 9. Why not `exact`

The standard `exact` scheme needs EIP-3009 on the token, or a deployed Permit2 and the x402 Permit2 proxy.

- **EIP-3009:** USDC on Incentiv implements neither EIP-3009 nor EIP-2612.
- **Permit2:** the proxy's published bytecode uses `MCOPY`, which Incentiv's EVM does not support. A Permit2 pull would also move funds outside the smart account's TransferGate check.

The two schemes here keep every payment a direct transfer by the payer.
