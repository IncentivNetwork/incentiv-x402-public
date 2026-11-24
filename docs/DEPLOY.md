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
- **Persistent data (required).** Mount EFS (or an EBS volume) at `/data`. It holds settled payments, which are kept for seven days, and submission claims, which are written before submission and retained for up to seven days from the first attempt. It also holds active UserOperation history checkpoints and the discovery catalog when discovery is on. After a restart, a confirmed nonce advance starts a fresh grace period. Each write is synced to disk before it replaces the file. Without it, a payment whose settle timed out just before a restart is refused on retry (`already_settled`), so its payer is charged but not served, and, with discovery on, the catalog starts empty.
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
  | `store_error` | The claims and results store failed. Recording a claim or a success answers `store_unavailable` or `settle_unrecorded`. If the final `nonce_used` write fails, settlement answers `settle_timeout` and retains the retryable claim. A failed claim release or revert write keeps its original response |
  | `unexpected_error`, `error` | A bug or an unexpected failure (answered `internal error` or HTTP 500) |
  | `catalog_rejected`, `catalog_error` | A listing was refused (with the detail, when there is one), or the catalog failed; the settle result is unchanged |
  | `catalog_load_failed`, `catalog_save_failed` | `catalog.json` could not be read (moved to `catalog.json.corrupt-<time>`) or written (retried with backoff; the final write at exit is not retried) |

## Kubernetes on EKS

- Configure the facilitator Deployment in your infrastructure with `replicas: 1` and `strategy.type: Recreate`. Use a persistent volume mounted at the facilitator's data directory and keep autoscaling disabled. A release waits for the old revision to terminate before starting the new one, so plan for a short interruption. During maintenance, avoid deleting a running pod directly: the ReplicaSet can start a replacement before termination finishes. Use a Deployment rollout or scale to zero and confirm the old process has stopped before scaling back up.
- Use SIGTERM and set `terminationGracePeriodSeconds` to at least 75 in the pod template. If the facilitator has a `preStop` hook, use a Kubernetes `sleep` handler and add its full duration to that minimum. Apply these settings and confirm the running pod uses them before enabling the release workflow. Changing a template does not extend the grace period of an existing pod.
- Set the `prod` environment variable `K8S_CONTAINER` to the facilitator container name. The release workflow checks the Deployment's rollout and shutdown settings before updating that container.

### Release a version

Protect `main` with PR review and restrict the GitHub `prod` environment to the **branch** `main` only. Remove any tag policies from that environment. Configure the AWS role to require the repository's exact `prod` OIDC subject and the `sts.amazonaws.com` audience. Use the immutable subject with owner and repository IDs when enabled in the repository's OIDC settings. Limit the role to the configured ECR repository and EKS cluster, and limit its Kubernetes access to the facilitator Deployment. Enable immutable image tags on the ECR repository and protect Git release tags from updates and deletion.

Set `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REPOSITORY`, `EKS_CLUSTER`, `K8S_NAMESPACE`, `K8S_DEPLOYMENT` and `K8S_CONTAINER` as variables in `prod`. Push a `vX.Y.Z` tag on a commit already on `main`. Run **Deploy facilitator** from `main` in GitHub Actions with that tag, or use `gh workflow run deploy.yml --ref main -f tag=vX.Y.Z`. The workflow tests the tagged commit using the current CI matrix before building or reusing the immutable image and deploying by digest. Tag creation by itself does not start a release.

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
