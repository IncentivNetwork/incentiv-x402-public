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
- Before the first release and after changing infrastructure, verify that the running pod mounts the intended persistent storage read-write at `FACILITATOR_DATA_DIR` (`/data` by default). If using a persistent volume claim, verify the claim is bound and the running pod and Deployment template reference the same claim.
- Configure the facilitator container's HTTP `readinessProbe` to GET `/health` on its listening port (`4020` by default). Use the pod IP and either the port number or a name declared for that TCP port on the facilitator container. If using `envFrom` or a custom listening port, set `PORT` explicitly as a literal in the container's `env`. Set `timeoutSeconds` to at least 25 to allow a single RPC attempt of up to 20 seconds plus HTTP overhead. Retries may take longer. The rollout waits for Kubernetes to report the new pod as available. Use the service endpoint checks below to verify traffic through the load balancer.
- Set the `prod` environment variable `K8S_CONTAINER` to the facilitator container name. The release workflow checks the Deployment template's rollout, readiness and shutdown settings before updating that container.

### Release a version

Protect `main` with PR review and restrict the GitHub `prod` environment to the **branch** `main` only. Remove any tag policies from that environment. Configure the AWS role to require the repository's exact `prod` OIDC subject and the `sts.amazonaws.com` audience. Use the immutable subject with owner and repository IDs when enabled in the repository's OIDC settings. Limit the role to the configured ECR repository and EKS cluster, and limit its Kubernetes access to the facilitator Deployment. Enable immutable image tags on the ECR repository and protect Git release tags from updates and deletion.

Set `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REPOSITORY`, `EKS_CLUSTER`, `K8S_NAMESPACE`, `K8S_DEPLOYMENT` and `K8S_CONTAINER` as variables in `prod`. Push a `vX.Y.Z` tag on a commit already on `main`. Run **Deploy facilitator** from `main` in GitHub Actions with that tag, or use `gh workflow run deploy.yml --ref main -f tag=vX.Y.Z`. The workflow tests the tagged commit using the current CI matrix before building or reusing the immutable image and deploying by digest. Tag creation by itself does not start a deployment. It publishes the npm package; see [Publish the npm package](#publish-the-npm-package).

This workflow releases code already on `main`. For fixes under coordinated disclosure, deploy the verified build privately before publishing the source and retain the commit and image digest for verification at publication.

The release workflow records the tested Git commit and the digest reported by Buildx in AWS Systems Manager Parameter Store under `/x402/releases/<ECR_REPOSITORY>/<tag>`. Grant `ssm:GetParameters` and create-only `ssm:PutParameter` on this path to the trusted release role. Enforce the `ssm:Overwrite` IAM condition, deny deletion to the release role and keep write access separate from general ECR publishing access. A rerun or rollback checks the existing version tag against this record. For a legacy tag without a record, choose a new version tag and build it through the release workflow.

Keep staged `candidate-*` images until their versions are published so a rerun can finish an interrupted publication. ECR lifecycle rules expire images and all their tags. A rule matching `candidate-*` can therefore expire an image with a release tag. Preview lifecycle policies and confirm that they retain in-progress releases, the running image and supported rollback images. To clean up a published candidate, verify that its version tag points to the same digest and remove only the candidate tag by name.

Production deployments run one at a time. Each image update records the highest requested version in `x402.incentiv.io/highest-release` and the newest requested source commit by Git ancestry in `x402.incentiv.io/newest-release-commit`, even if the rollout fails. Keep both Deployment annotations when applying infrastructure changes. When adopting this workflow for an existing release, seed them from its verified version and commit. If only the version is present, the workflow resolves its immutable Git tag.

To rerun a release, use its immutable tag and original commit. For a new release after the first, create a higher version tag on the newest requested source commit or a descendant. Both limits continue to apply to normal releases after a rollback.

### Roll back a release

Select a tag with a verified existing ECR image. Inspect the Deployment's current image and copy its `UID:generation` from the same read. Substitute your namespace and Deployment name in this command.

```bash
kubectl -n x402 get deployment facilitator \
  -o go-template='{{.metadata.uid}}:{{.metadata.generation}}{{"\n"}}{{range .spec.template.spec.containers}}{{.name}} {{.image}}{{"\n"}}{{end}}'
```

Dispatch **Deploy facilitator** from `main` with the target tag, `rollback` set to `true`, and the inspected value in `rollback_from`. The workflow checks that the Deployment UID and generation still match. If either differs, inspect the new release before dispatching another rollback.

Release and rollback commits must include `c81d10f`, the release baseline with durable submission recovery and the publication fixes. Check rollback compatibility using a staging copy of the current data before rolling back. When changing the persisted format, verify that supported rollback versions can read and preserve the new data. If they cannot, plan a migration that keeps settlement records intact and update the workflow's release baseline before enabling the new format in production.

## Publish the npm package

Pushing a `vX.Y.Z` tag runs **Publish to npm**. The workflow requires the tag to point to a commit on `main` and to match the `package.json` version at that commit, tests that commit with the CI matrix and publishes `@incentiv/x402` with provenance through npm trusted publishing. No npm token is stored in GitHub. A prerelease tag such as `v0.2.0-rc.1` publishes under the `next` dist-tag; only a release moves `latest`. To publish an existing tag again after a failed run, dispatch the workflow from `main` with the tag, or use `gh workflow run publish.yml --ref main -f tag=vX.Y.Z`. A version that is already on npm is not published again.

Bump the version in `package.json` through a pull request before tagging. The same tag can then be deployed with **Deploy facilitator**.

Restrict the GitHub `npm` environment to the branch `main` and tags `v*`. In the package settings on npmjs.com, add a trusted publisher for the GitHub repository `IncentivNetwork/incentiv-x402-public`, workflow `publish.yml` and environment `npm`. Then require two-factor authentication and disallow tokens for publishing. Trusted publishers can only be added to a package that already exists, so the first version is published once by an owner of the `@incentiv` npm organization.

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

1. Check `https://<your-host>/health` returns HTTP 200 with both `rpc` and `bundler` set to `ok`. Check `https://<your-host>/supported` lists the facilitator's schemes.
2. Run `npm run e2e` against it with a funded test payer (point the merchant at the new facilitator URL).
3. Give merchants the seller quickstart in the README.
