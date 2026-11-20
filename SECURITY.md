# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. We aim to acknowledge reports within three working days.

## Scope

In scope:

- The `incentiv-eoa-tx` and `incentiv-userop` schemes: anything that lets a payment verify or settle when it should not, pay a different recipient or amount than quoted, settle twice, or be reported as a success to more than one request.
- The facilitator service: anything that lets a request bypass verification, exhaust the service, or read data it should not.

Out of scope:

- Contracts on Incentiv (EntryPoint, account factory, paymaster, TransferGate). Report those to the Incentiv team.
- Issues that need a payer's private key, or a facilitator run against the deployment guide's "exactly one instance" rule.

## Design notes for reviewers

- The facilitator holds no private key. It submits transactions and user operations that payers already signed.
- Expiry is enforced by the facilitator, not by the chain. A signed payment that was never settled stays valid on chain until its nonce is used.
- The facilitator's single-claimant guarantee (one payment, one served request) relies on claims kept in its persistent store (`/data`) and on in-memory in-flight tracking. It holds only for a single instance with persistent storage.
- The discovery catalog is written by anyone who settles a USDC payment, and its listings are not signed by the merchant. Other details for a listing are served only once the payments for them outscore the listing's recent payments, which go to the merchant. Its contents are unauthenticated, untrusted and size-capped. The facilitator never compiles the payer's JSON schema, and rejects one that uses regular expressions (`pattern`, `patternProperties`) or references (`$ref`, `$id`, `$anchor`), since consumers that call the Bazaar SDK's default extraction would compile it. Consumers should still treat every served field, schemas included, as untrusted input.
- Errors from the chain, the bundler and libraries reach clients as one line with URLs removed, or as a generic message for unexpected errors. The facilitator's own validation messages are returned as written. Full errors go to the facilitator's log, with each URL cut to its host.
