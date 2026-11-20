import { join } from "node:path";
import { MAINNET, type IncentivConfig } from "../constants.js";
import { createFacilitatorApp } from "./app.js";
import { Catalog } from "./catalog.js";
import { FileStore } from "./store.js";
import { logMessage } from "../decode.js";

// Configuration is read from the environment so the same image runs anywhere.
const env = (name: string) => (process.env[name] === undefined || process.env[name] === "" ? undefined : process.env[name]);
/** A positive integer setting, or the default; anything else stops the process at startup. */
const intEnv = (name: string, fallback?: number): number | undefined => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    console.error(`${name} must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return Number(raw);
};
const port = intEnv("PORT", 4020)!;
const dataDir = env("FACILITATOR_DATA_DIR") ?? join(process.cwd(), "data");
const config: IncentivConfig = {
  ...MAINNET,
  rpcUrl: env("INCENTIV_RPC_URL") ?? MAINNET.rpcUrl,
  bundlerUrl: env("INCENTIV_BUNDLER_URL") ?? MAINNET.bundlerUrl,
};
const trust = env("TRUST_PROXY");
if (trust === "true") {
  console.error('TRUST_PROXY=true would trust a forged X-Forwarded-For; set the number of proxies in front instead (1 behind one load balancer)');
  process.exit(1);
}
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...line }));

const catalog = new Catalog(join(dataDir, "catalog.json"), Date.now, log);
const { app } = createFacilitatorApp({
  config,
  store: new FileStore(join(dataDir, "settled.json")),
  catalog,
  trustProxy: trust === undefined ? undefined : /^\d+$/.test(trust) ? Number(trust) : trust,
  verifyPerMinute: intEnv("VERIFY_PER_MINUTE"),
  settlePerMinute: intEnv("SETTLE_PER_MINUTE"),
  discoveryPerMinute: intEnv("DISCOVERY_PER_MINUTE"),
  log,
});

// Only hosts are logged: dedicated RPC URLs often carry an API key in the path or query.
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "invalid url";
  }
};
const server = app.listen(port, () => log({ event: "listening", port, dataDir, rpc: host(config.rpcUrl), bundler: host(config.bundlerUrl) }));
// Settles still in flight can add catalog entries, so the catalog is written last, right before exiting.
const exit = (code: number) => {
  try {
    catalog.flush();
  } catch (e) {
    log({ event: "catalog_save_failed", error: logMessage(e) });
  }
  process.exit(code);
};
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      // A repeated SIGTERM (an orchestrator resending it) must not cut off the settles being waited for; a second
      // Ctrl-C is an operator forcing the stop.
      if (signal === "SIGINT") {
        log({ event: "shutdown_forced", signal });
        return exit(1);
      }
      return log({ event: "shutdown_in_progress", signal });
    }
    shuttingDown = true;
    log({ event: "shutdown", signal });
    server.close(() => exit(0));
    setTimeout(() => exit(1), 70_000).unref(); // let an in-flight settle finish (it waits up to 60 s)
  });
}
