import { join } from "node:path";
import { MAINNET, type IncentivConfig } from "../constants.js";
import { createFacilitatorApp } from "./app.js";
import { Catalog } from "./catalog.js";
import { FileStore } from "./store.js";

// Configuration is read from the environment so the same image runs anywhere.
const env = (name: string) => (process.env[name] === undefined || process.env[name] === "" ? undefined : process.env[name]);
const port = Number(env("PORT") ?? 4020);
const dataDir = env("FACILITATOR_DATA_DIR") ?? join(process.cwd(), "data");
const config: IncentivConfig = {
  ...MAINNET,
  rpcUrl: env("INCENTIV_RPC_URL") ?? MAINNET.rpcUrl,
  bundlerUrl: env("INCENTIV_BUNDLER_URL") ?? MAINNET.bundlerUrl,
};
const trust = env("TRUST_PROXY");
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...line }));

const { app } = createFacilitatorApp({
  config,
  store: new FileStore(join(dataDir, "settled.json")),
  catalog: new Catalog(join(dataDir, "catalog.json")),
  trustProxy: trust === undefined ? undefined : /^\d+$/.test(trust) ? Number(trust) : trust === "true" ? true : trust,
  verifyPerMinute: env("VERIFY_PER_MINUTE") ? Number(env("VERIFY_PER_MINUTE")) : undefined,
  settlePerMinute: env("SETTLE_PER_MINUTE") ? Number(env("SETTLE_PER_MINUTE")) : undefined,
  log,
});

const server = app.listen(port, () => log({ event: "listening", port, dataDir, rpc: config.rpcUrl, bundler: config.bundlerUrl }));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log({ event: "shutdown", signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 70_000).unref(); // let an in-flight settle finish (it waits up to 60 s)
  });
}
