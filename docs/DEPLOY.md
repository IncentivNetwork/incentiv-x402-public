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
| `FACILITATOR_DATA_DIR` | `/data` | Holds `settled.json` and `catalog.json`; mount a persistent volume here |
| `INCENTIV_RPC_URL` | `https://rpc.incentiv.io` | Chain RPC; use a dedicated endpoint in production |
| `INCENTIV_BUNDLER_URL` | `https://bundler.incentiv.io` | ERC-4337 bundler, used by `incentiv-userop` |
| `TRUST_PROXY` | unset | Set to `1` behind one load balancer (an AWS ALB), so rate limits count real client addresses |
| `VERIFY_PER_MINUTE` | `120` | Per-address limit on `/verify` |
| `SETTLE_PER_MINUTE` | `60` | Per-address limit on `/settle` |

## AWS notes

- **One task.** Use an ECS service with desired count 1, or a single EC2 instance. Do not autoscale it.
- **Persistent data.** Mount EFS (or an EBS volume) at `/data`. Without it, the discovery catalog is empty after every restart. Payments stay safe either way, because the chain's own nonce rules stop a replay.
- **Health check.** `GET /health` returns 200 when the RPC and the bundler both answer, and 503 otherwise. The image has a built-in container health check.
- **TLS and domain.** Terminate TLS at the load balancer and point `x402.incentiv.io` (or your chosen name) at it. Merchants set this URL as their facilitator.
- **Shutdown.** On SIGTERM it stops accepting requests and waits up to 70 seconds, because a settle can wait up to 60 seconds for a receipt. Set the ECS stop timeout to at least 75 seconds.
- **Logs.** One JSON line per settle (`event: "settle"`, scheme, success, reason, transaction, payer, amount) and per start or stop, on stdout.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /supported` | Schemes and extensions on offer (`bazaar` among them) |
| `POST /verify`, `POST /settle` | The x402 facilitator API |
| `GET /health` | RPC and bundler status |
| `GET /discovery/resources` | List cataloged paid resources; filters `type`, `payTo`, `scheme`, `network`, `limit`, `offset` |
| `GET /discovery/search?query=` | Search cataloged resources |

## Discovery

A resource is cataloged when a payment for it settles successfully and its route declared Bazaar discovery info (`declareDiscoveryExtension`). There is no manual registration. The merchant sees the outcome in the facilitator's `EXTENSION-RESPONSES` header: `bazaar.status` is `success` or `rejected`.

## After deploying

1. Open `https://<your-host>/health` and `https://<your-host>/supported`.
2. Run `npm run e2e` against it with a funded test payer (point the merchant at the new facilitator URL).
3. Give merchants the seller quickstart in the README.
