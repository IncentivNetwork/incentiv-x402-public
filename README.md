# @incentiv/x402

[x402](https://x402.org) payments on [Incentiv](https://incentiv.io) (`eip155:24101`), as plug-ins for the stock `@x402/*` packages, plus the facilitator service that verifies and settles them.

Sellers keep using `@x402/express`, `@x402/next` or `@x402/hono`. Buyers keep using `@x402/fetch` or `@x402/axios`. Each registers one Incentiv scheme.

| Scheme | Payer | Payment | Gas |
| --- | --- | --- | --- |
| `incentiv-eoa-tx` | A plain wallet (EOA) | A signed USDC transfer | Paid by the payer in CENT |
| `incentiv-userop` | An Incentiv smart account | A signed ERC-4337 user operation | Paid by the payer in USDC through the Unified Token Paymaster, or in CENT from the account |

The asset is USDC (`0x16e43840d8D79896A389a3De85aB0B0210C05685`, 6 decimals). The protocol details are in [docs/SPEC.md](docs/SPEC.md).

## Install

```bash
npm install @incentiv/x402
```

Node.js 22.18 or later.

## Sell: protect a route

```ts
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { IncentivEoaTxScheme, IncentivUserOpScheme } from "@incentiv/x402";

const NETWORK = "eip155:24101";
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL }));
server.register(NETWORK, new IncentivEoaTxScheme());
server.register(NETWORK, new IncentivUserOpScheme());

const pay = (scheme: string) => ({ scheme, network: NETWORK, payTo: "0xYourIncentivAddress", price: "$0.01", maxTimeoutSeconds: 120 });

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [pay("incentiv-eoa-tx"), pay("incentiv-userop")],
        description: "Current weather",
        mimeType: "application/json",
      },
    },
    server,
  ),
);
app.get("/weather", (_req, res) => res.json({ city: "Kyiv", tempC: 21 }));
app.listen(4021);
```

- Offer one or both schemes. A buyer pays with the first one it supports.
- `price` is in USD and is paid in USDC. `maxTimeoutSeconds` is capped at 300; 120 is a good default.
- The content is served only after payment settles. By default the handler can start before settlement. Set `extra: { paymentFlow: "upfront" }` on each payment option for routes that perform expensive work or have side effects. Upfront settlement charges before the handler starts and does not refund a later handler failure.
- `@x402/next` (`withX402`, `paymentProxy`) and `@x402/hono` (`paymentMiddleware`) take the same `server`.

### Be discoverable

Declare discovery info, and a facilitator that runs with discovery on catalogs the route after its first paid request. Agents then find it through `/discovery/resources` and `/discovery/search`. No registration is needed. Discovery is optional and off by default (`DISCOVERY=on` enables it). A facilitator that offers it lists `bazaar` under `extensions` in its `/supported` answer.

```ts
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

server.registerExtension(bazaarResourceServerExtension);
// in the route config:
//   serviceName: "Example Weather",
//   tags: ["weather"],
//   extensions: { ...declareDiscoveryExtension({ output: { example: { city: "Kyiv", tempC: 21 } } }) },
```

## Buy: pay for a route

```ts
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { IncentivEoaTxClientScheme } from "@incentiv/x402";

const client = new x402Client();
client.register("eip155:24101", new IncentivEoaTxClientScheme({ owner: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`) }));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPayment("https://api.example.com/weather");
```

To pay from a smart account instead, register `IncentivUserOpClientScheme`:

```ts
import { IncentivUserOpClientScheme } from "@incentiv/x402";

const scheme = new IncentivUserOpClientScheme({ owner, gas: "token" }); // gas: "token" (USDC, the default) or "native" (CENT)
client.register("eip155:24101", scheme);
console.log(await scheme.account()); // the smart account that pays
```

Both clients decode what they are about to sign and refuse anything that is not exactly the quoted payment. With `gas: "token"`, the smart-account client also refuses a gas fee above `maxGasFee` (USDC atomic units, default `250_000n`, 0.25 USDC), and refuses to pay gas in any token other than USDC. With `gas: "native"`, it refuses an operation that may cost more than `maxNativeGasCost` in CENT (wei, default 100 CENT, exported as `DEFAULT_MAX_NATIVE_GAS_COST`).

### Funding a payer

| Payer | Holds | Address |
| --- | --- | --- |
| EOA (`incentiv-eoa-tx`) | USDC for prices, CENT for gas | Your wallet address, the same on every chain |
| Smart account (`incentiv-userop`) | USDC for prices and, by default, gas | Derived from your key; it exists **only on Incentiv** |

**Fund the smart account on Incentiv only.** Its address has no contract on other chains, so funds sent to it on Ethereum or elsewhere cannot be moved by your key. To bridge in, set it as the recipient in the Incentiv Bridge.

An EOA can have one payment settling at a time, and cannot pay while it has a pending transaction. A smart account can have many payments in flight, because each uses its own nonce lane.

## Run the facilitator

```bash
docker build -t incentiv-x402-facilitator .
docker run -p 4020:4020 -v x402-data:/data incentiv-x402-facilitator
```

It serves `/supported`, `/verify`, `/settle` and `/health`, and with `DISCOVERY=on` also `/discovery/resources` and `/discovery/search`. It holds no private key. **Run exactly one instance, with persistent storage at `/data`.** Configuration, AWS notes and operations are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Costs

The facilitator charges nothing. The buyer pays gas on top of the price, unlike `exact` on networks whose facilitators pay gas. On 2026-11-19, a payment cost about 2 CENT of gas from an EOA, or about 0.03 USDC through the paymaster, whose minimum is 0.026 USDC.

## Develop

| Command | Does |
| --- | --- |
| `npm test` | Unit tests. One test reads the live EntryPoint to check the user operation hash. |
| `npm run build` | Compiles `src` to `dist` |
| `npm run facilitator` | Runs the facilitator from source on `PORT` (default 4020) |
| `npm run keys` | Generates throwaway payer and merchant keys into the gitignored `.env.e2e` |
| `npm run where` | Shows the test addresses' balances on Incentiv and Ethereum |
| `npm run fund-smart-account [-- 0.5] [--dry]` | Moves USDC from the test EOA to its smart account on Incentiv |
| `npm run e2e` | Mainnet end-to-end test for `incentiv-eoa-tx`. Needs 0.10 USDC and 12 CENT at the test EOA. |
| `npm run e2e:userop` | The same for `incentiv-userop`. Needs 0.40 USDC at the test smart account. `E2E_GAS=cent` pays gas in CENT. |

The end-to-end tests spend real funds on mainnet; Incentiv has no testnet. `E2E_ONLY="paid request,replaying"` runs a subset.

## Limitations

- These are custom schemes. Clients without this package cannot pay, and stock `exact` clients do not recognise them. `exact` needs EIP-3009 or a working Permit2 proxy, and neither is available on Incentiv today; see the spec.
- Expiry is enforced by the facilitator, not the chain. A signed payment that is never settled stays valid on chain until its nonce is used.
- The facilitator's guarantees rely on in-memory state, so it must run as a single instance.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately.

## License

[MIT](LICENSE)
