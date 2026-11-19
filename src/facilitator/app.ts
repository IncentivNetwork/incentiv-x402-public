import express, { type Express, type Request, type Response } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { NETWORK } from "../constants.js";
import { Catalog } from "./catalog.js";
import { IncentivEoaTxFacilitatorScheme } from "../scheme/facilitator-eoa.js";
import { IncentivUserOpFacilitatorScheme, type FacilitatorOptions } from "../scheme/facilitator.js";
import { makeChain } from "../userop.js";

/** A fixed-window counter per client address. */
class RateLimit {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    h.count += 1;
    return h.count <= this.limit;
  }
}

export interface FacilitatorAppOptions extends FacilitatorOptions {
  verifyPerMinute?: number;
  settlePerMinute?: number;
  /** Where discovered resources are kept. Defaults to an in-memory catalog. */
  catalog?: Catalog;
  /** Express "trust proxy" setting, so rate limits see the real client address behind a load balancer. */
  trustProxy?: boolean | number | string;
  /** Called with one line of JSON per settle outcome. */
  log?: (line: Record<string, unknown>) => void;
}

export function createFacilitatorApp(options: FacilitatorAppOptions = {}): {
  app: Express;
  scheme: IncentivUserOpFacilitatorScheme;
  eoaScheme: IncentivEoaTxFacilitatorScheme;
  catalog: Catalog;
} {
  const scheme = new IncentivUserOpFacilitatorScheme(options);
  const eoaScheme = new IncentivEoaTxFacilitatorScheme(options);
  const catalog = options.catalog ?? new Catalog();
  const facilitator = new x402Facilitator().register(NETWORK, eoaScheme).register(NETWORK, scheme).registerExtension({ key: "bazaar" });
  const chain = makeChain(options.config);
  const verifyLimit = new RateLimit(options.verifyPerMinute ?? 120);
  const settleLimit = new RateLimit(options.settlePerMinute ?? 60);

  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);
  app.use(express.json({ limit: "64kb" }));

  const limited = (limit: RateLimit) => (req: Request, res: Response, next: () => void) => {
    if (limit.allow(req.ip ?? "unknown")) return next();
    res.status(429).json({ error: "rate_limited" });
  };

  const body = (req: Request, res: Response) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ error: "invalid_request" });
      return undefined;
    }
    return { paymentPayload, paymentRequirements };
  };

  app.get("/supported", (_req, res) => {
    res.set("cache-control", "public, max-age=60").json(facilitator.getSupported());
  });

  app.get("/health", async (_req, res) => {
    const ok = async (f: () => Promise<unknown>) => f().then(() => "ok", () => "down");
    const [rpc, bundler] = await Promise.all([
      ok(() => chain.client.getBlockNumber()),
      ok(async () => {
        const r = await fetch(chain.config.bundlerUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; incentiv-x402)" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints", params: [] }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!r.ok) throw new Error(String(r.status));
      }),
    ]);
    res.status(rpc === "ok" && bundler === "ok" ? 200 : 503).json({ status: rpc === "ok" && bundler === "ok" ? "ok" : "degraded", rpc, bundler });
  });

  app.post("/verify", limited(verifyLimit), async (req, res) => {
    const b = body(req, res);
    if (!b) return;
    res.json(await facilitator.verify(b.paymentPayload, b.paymentRequirements));
  });

  app.post("/settle", limited(settleLimit), async (req, res) => {
    const b = body(req, res);
    if (!b) return;
    const result = await facilitator.settle(b.paymentPayload, b.paymentRequirements);
    options.log?.({
      event: "settle",
      scheme: b.paymentRequirements.scheme,
      success: result.success,
      reason: result.errorReason,
      transaction: result.transaction || undefined,
      payer: result.payer,
      amount: result.amount,
    });
    // A paid resource that declared Bazaar discovery info is cataloged, and the merchant is told the outcome.
    if (result.success && b.paymentPayload.extensions?.bazaar) {
      const status = catalog.record(b.paymentPayload, b.paymentRequirements);
      res.set("EXTENSION-RESPONSES", Buffer.from(JSON.stringify({ bazaar: status })).toString("base64"));
    }
    res.json(result);
  });

  const num = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

  app.get("/discovery/resources", (req, res) => {
    const q = req.query;
    res.json(catalog.list({ type: str(q.type), payTo: str(q.payTo), scheme: str(q.scheme), network: str(q.network), limit: num(q.limit), offset: num(q.offset) }));
  });

  app.get("/discovery/search", (req, res) => {
    const q = req.query;
    res.json(catalog.search({ query: str(q.query) ?? "", type: str(q.type), payTo: str(q.payTo), scheme: str(q.scheme), network: str(q.network), limit: num(q.limit) }));
  });

  return { app, scheme, eoaScheme, catalog };
}
