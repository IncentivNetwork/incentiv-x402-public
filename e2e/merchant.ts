import express, { type Express } from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { DEFAULT_TIMEOUT_SECONDS, EOA_SCHEME, IncentivEoaTxScheme, IncentivUserOpScheme, NETWORK, SCHEME } from "../src/index.js";

/** A demo merchant: one paid, discoverable route that accepts either Incentiv scheme, built from stock x402 packages. */
export function createMerchant(opts: { facilitatorUrl: string; payTo: string; price?: string }): Express {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: opts.facilitatorUrl }));
  server.register(NETWORK, new IncentivEoaTxScheme());
  server.register(NETWORK, new IncentivUserOpScheme());
  server.registerExtension(bazaarResourceServerExtension);
  const option = (scheme: string) => ({ scheme, network: NETWORK, payTo: opts.payTo, price: opts.price ?? "$0.01", maxTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS });
  const app = express();
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: [option(EOA_SCHEME), option(SCHEME)],
          description: "Current weather in Kyiv",
          mimeType: "application/json",
          serviceName: "Incentiv Demo Weather",
          tags: ["weather", "demo"],
          extensions: {
            ...declareDiscoveryExtension({
              output: { example: { city: "Kyiv", tempC: 21 }, schema: { type: "object", properties: { city: { type: "string" }, tempC: { type: "number" } } } },
            }),
          },
        },
      },
      server,
    ),
  );
  app.get("/weather", (_req, res) => res.json({ city: "Kyiv", tempC: 21 }));
  return app;
}
