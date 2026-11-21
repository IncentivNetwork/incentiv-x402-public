# Deploying the Incentiv x402 facilitator

The facilitator verifies and settles x402 payments for the `incentiv-eoa-tx` and `incentiv-userop` schemes on Incentiv mainnet (`eip155:24101`). It holds no private key: it only submits transactions that payers already signed.

## Run exactly one instance

The facilitator keeps three things in memory: which payments are being settled, which payers are mid-payment, and which payer nonces are in use. Two instances would each believe they are the only claimant, and one payment could then be reported as a success twice. Run **one task or replica**, and restart it in place when it fails.

## Build and run

```bash
docker build -t incentiv-x402-facilitator .
docker run -p 4020:4020 -v x402-data:/data incentiv-x402-facilitator
```

## Configuration

All settings are environment variables. Defaults are Incentiv mainnet.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4020` | Listening port |
| `FACILITATOR_DATA_DIR` | `/data` in the Docker image, `./data` otherwise | Holds `settled.json` and, with discovery on, `catalog.json`; mount a persistent volume here |
| `INCENTIV_RPC_URL` | `https://rpc.incentiv.io` | Chain RPC; use a dedicated endpoint in production |
| `INCENTIV_BUNDLER_URL` | `https://bundler.incentiv.io` | ERC-4337 bundler, used by `incentiv-userop` |
| `TRUST_PROXY` | unset | Set to `1` behind one load balancer (an AWS ALB), so rate limits count real client addresses. The number of proxies, or their addresses (Express syntax); `true` is refused, because it would trust a forged `X-Forwarded-For`. IPv6 clients are counted per /64. |
| `VERIFY_PER_MINUTE` | `120` | Per-address limit on `/verify` |
| `SETTLE_PER_MINUTE` | `60` | Per-address limit on `/settle` |
| `DISCOVERY` | `off` | `on` enables Bazaar discovery: the catalog of paid resources, `/discovery/resources`, `/discovery/search` and the `bazaar` extension in `/supported`. Unset or empty means `off`, as for every setting here; any other value stops startup. |
| `DISCOVERY_PER_MINUTE` | `120` | Per-address limit on `/discovery/resources` and `/discovery/search`, with discovery on |

## AWS notes

- **One task.** Use an ECS service with desired count 1, or a single EC2 instance. Do not autoscale it.
- **Persistent data (required).** Mount EFS (or an EBS volume) at `/data`. It holds the settled payments (kept for 7 days, then forgotten; a forgotten payment is still refused on retry), the claims the facilitator records before submitting each payment, and, with discovery on, the discovery catalog. Each write is synced to disk before it replaces the file. Without it, a payment whose settle timed out just before a restart is refused on retry (`already_settled`), so its payer is charged but not served, and, with discovery on, the catalog starts empty.
- **Damaged data files.** With discovery on, a `catalog.json` that cannot be read is moved aside and the catalog starts empty; paid requests rebuild it. A `settled.json` that cannot be read stops startup on purpose: starting without it would forget which payments were already reported, and one payment could then serve two requests. Keep the damaged file, restore the latest backup of `/data` if there is one, and start again. Empty the `claims` object in a restored `settled.json` first: a backup taken while a payment was being settled holds its claim without its result, and the payment could then be reported as a success a second time. If there is none, move the file aside and start: a payment settled before is then refused on retry (`already_settled`) rather than reported twice, so the payers of settles that were in flight are charged but not served.
- **Health check.** `GET /health` returns 200 when the RPC and the bundler both answer, and 503 otherwise. The image has a built-in container health check.
- **TLS and domain.** Terminate TLS at the load balancer and point `x402.incentiv.io` (or your chosen name) at it. Merchants set this URL as their facilitator.
- **Shutdown.** On SIGTERM it stops accepting requests and waits up to 70 seconds, because a settle can take up to 60 seconds from its chain checks to its answer, submission included. Set the ECS stop timeout to at least 75 seconds.
- **Logs.** One JSON line per event on stdout, with `time` and `event`. URLs in errors are cut to their host.

  | Event | When |
  | --- | --- |
  | `listening`, `shutdown`, `shutdown_in_progress`, `shutdown_forced` | Start (with `discovery`: `on` or `off`), stop, a repeated SIGTERM (ignored), a SIGINT after the first signal of either kind (forced stop) |
  | `settle` | Every settle: scheme, success, reason, transaction, payer, amount |
  | `payment_error` | The original error behind a refused payment (for example a provider error) |
  | `submit_unknown` | Submitting a payment got no answer (a lost connection, a timeout, a 5xx status, an internal error, a transient RPC answer such as a rate limit, or no answer within the settle window), or was refused while the payment may still land (a nonce refusal, a refused resend, its nonce is used or pending, the bundler still holds the operation, or the RPC or bundler cannot say). The claim is kept and the receipt decides; the merchant retries a `settle_timeout` with the same payload |
  | `settle_checks_timeout` | A settle's chain checks did not finish within the settle window; it answered `settle_timeout` and nothing was submitted |
  | `userop_reverted` | The full revert reason of a UserOperation that reverted on chain |
  | `store_error` | The claims and results store failed. Recording a claim or a success answers `store_unavailable` or `settle_unrecorded`; releasing a claim, or recording a failure, keeps the answer (`tx_rejected`, `userop_rejected`, or the revert) |
  | `unexpected_error`, `error` | A bug or an unexpected failure (answered `internal error` or HTTP 500) |
  | `catalog_rejected`, `catalog_error` | A listing was refused (with the detail, when there is one), or the catalog failed; the settle result is unchanged |
  | `catalog_load_failed`, `catalog_save_failed` | `catalog.json` could not be read (moved to `catalog.json.corrupt-<time>`) or written (retried with backoff; the final write at exit is not retried) |

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /supported` | Schemes and extensions on offer (`bazaar` among them, with discovery on) |
| `POST /verify`, `POST /settle` | The x402 facilitator API |
| `GET /health` | RPC and bundler status |
| `GET /discovery/resources` | With discovery on: list cataloged paid resources; filters `type`, `payTo`, `scheme`, `network`, `limit`, `offset` |
| `GET /discovery/search?query=` | With discovery on: search cataloged resources |

## Discovery

Discovery is optional and off by default; set `DISCOVERY=on` to enable it. With it off, the facilitator keeps no catalog and does not read or write `catalog.json`, `/discovery/*` answers 404, `/supported` does not list `bazaar`, and `/settle` sends no `EXTENSION-RESPONSES` header.

Upgrading a deployment that served discovery before it became optional: set `DISCOVERY=on` to keep it. With it off, an existing `catalog.json` stays in the data directory unused and can be deleted; if discovery is switched on later, the file is loaded again and its entries go through the current rules.

With discovery on, a resource is cataloged when a payment for it settles successfully and its route declared Bazaar discovery info (`declareDiscoveryExtension`). There is no manual registration. The merchant sees the outcome in the facilitator's `EXTENSION-RESPONSES` header: `bazaar.status` is `success` or `rejected`.

## After deploying

1. Open `https://<your-host>/health` and `https://<your-host>/supported`.
2. Run `npm run e2e` against it with a funded test payer (point the merchant at the new facilitator URL).
3. Give merchants the seller quickstart in the README.
