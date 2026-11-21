import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { EOA_SCHEME, NETWORK, SCHEME } from "../constants.js";
import { Catalog, QueryTooLongError } from "./catalog.js";
import { IncentivEoaTxFacilitatorScheme } from "../scheme/facilitator-eoa.js";
import { IncentivUserOpFacilitatorScheme, type FacilitatorOptions } from "../scheme/facilitator.js";
import { makeChain } from "../userop.js";
import { logMessage, logToStderr } from "../decode.js";

/**
 * The rate-limit key for a client address. An IPv6 client usually holds a whole /64, so it is counted per /64;
 * an IPv4 address, including one written as IPv4-mapped IPv6, is counted on its own.
 */
export function rateKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hexMapped) {
    const [hi, lo] = [parseInt(hexMapped[1]!, 16), parseInt(hexMapped[2]!, 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.toLowerCase().split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(8 - left.length - right.length, 0)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** A fixed-window counter per client address. */
export class RateLimit {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`rate limit must be a positive integer, got ${limit}`);
  }

  /** Number of client addresses currently tracked. */
  get size(): number {
    return this.hits.size;
  }
  allow(key: string, now = Date.now()): boolean {
    if (now >= this.nextSweep) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      this.nextSweep = now + this.windowMs;
    }
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
  /**
   * Bazaar discovery: the catalog of paid resources, `/discovery/*` and the `bazaar` extension in `/supported`.
   * Off by default; when off, no catalog is kept and a settle records nothing. Only `true` turns it on: any
   * value that is not a boolean (a string such as "off", say) is refused.
   */
  discovery?: boolean;
  /** Calls per minute per address to /discovery/*. Default 120. */
  discoveryPerMinute?: number;
  /**
   * Where discovered resources are kept. Defaults to an in-memory catalog. It needs `discovery: true`: a catalog
   * given with discovery off is refused, so discovery is never left off by mistake.
   */
  catalog?: Catalog;
  /**
   * Express "trust proxy" setting, so rate limits see the real client address behind a load balancer: the number
   * of proxies in front (1 behind an AWS ALB), or the proxies' addresses. `true` is refused, because it takes the
   * client address from the left end of X-Forwarded-For, which the client writes itself.
   */
  trustProxy?: false | number | string;
}

/** How long a /health answer is reused, so the endpoint cannot be used to flood the RPC and bundler. */
const HEALTH_CACHE_MS = 5_000;

export function createFacilitatorApp(options: FacilitatorAppOptions = {}): {
  app: Express;
  scheme: IncentivUserOpFacilitatorScheme;
  eoaScheme: IncentivEoaTxFacilitatorScheme;
  /** The catalog in use; undefined with discovery off. */
  catalog: Catalog | undefined;
} {
  // Discovery is on only for `discovery: true`. A truthy string from a setting ("off") must not turn it on, and
  // a catalog that would be ignored is a mistake worth stopping for.
  if (options.discovery !== undefined && typeof options.discovery !== "boolean") {
    throw new Error(`discovery must be true or false, got ${JSON.stringify(options.discovery)}`);
  }
  if (options.catalog !== undefined && options.discovery !== true) {
    throw new Error("a catalog needs discovery: true; with discovery off no catalog is kept");
  }
  // Without a log function, lines go to stderr, so unexpected errors are never silent.
  const log = options.log ?? logToStderr;
  const scheme = new IncentivUserOpFacilitatorScheme({ ...options, log });
  const eoaScheme = new IncentivEoaTxFacilitatorScheme({ ...options, log });
  const catalog = options.discovery === true ? (options.catalog ?? new Catalog(undefined, undefined, log)) : undefined;
  const facilitator = new x402Facilitator().register(NETWORK, eoaScheme).register(NETWORK, scheme);
  if (catalog) facilitator.registerExtension({ key: "bazaar" });
  const chain = makeChain(options.config);
  const verifyLimit = new RateLimit(options.verifyPerMinute ?? 120);
  const settleLimit = new RateLimit(options.settlePerMinute ?? 60);
  // Built, and so validated, in both modes; used only with discovery on.
  const discoveryLimit = new RateLimit(options.discoveryPerMinute ?? 120);

  const app = express();
  app.disable("x-powered-by");
  if ((options.trustProxy as unknown) === true || options.trustProxy === "true") {
    throw new Error("trustProxy: true trusts a forged X-Forwarded-For; give the number of proxies in front (1 behind one load balancer)");
  }
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);
  app.use(express.json({ limit: "64kb" }));

  const limited = (limit: RateLimit) => (req: Request, res: Response, next: () => void) => {
    if (limit.allow(rateKey(req.ip))) return next();
    res.status(429).json({ error: "rate_limited" });
  };

  const supportedSchemes = new Set<unknown>([SCHEME, EOA_SCHEME]);
  const body = (req: Request, res: Response) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements || typeof paymentPayload !== "object" || typeof paymentRequirements !== "object") {
      res.status(400).json({ error: "invalid_request" });
      return undefined;
    }
    // x402Facilitator throws for a scheme, network or version nothing is registered for: that is the client's
    // mistake, answered here as 400 rather than as an internal error.
    if (!supportedSchemes.has(paymentRequirements.scheme) || paymentRequirements.network !== NETWORK || paymentPayload.x402Version !== 2) {
      res.status(400).json({ error: "unsupported_scheme" });
      return undefined;
    }
    return { paymentPayload, paymentRequirements };
  };

  app.get("/supported", (_req, res) => {
    res.set("cache-control", "public, max-age=60").json(facilitator.getSupported());
  });

  let health: { at: number; result: Promise<{ rpc: string; bundler: string }> } | undefined;
  const checkHealth = async () => {
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
    return { rpc, bundler };
  };
  app.get("/health", async (_req, res) => {
    const now = Date.now();
    if (!health || now - health.at >= HEALTH_CACHE_MS) health = { at: now, result: checkHealth() };
    const { rpc, bundler } = await health.result;
    const up = rpc === "ok" && bundler === "ok";
    res.status(up ? 200 : 503).json({ status: up ? "ok" : "degraded", rpc, bundler });
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
    log({
      event: "settle",
      scheme: b.paymentRequirements.scheme,
      success: result.success,
      reason: result.errorReason,
      transaction: result.transaction || undefined,
      payer: result.payer,
      amount: result.amount,
    });
    // With discovery on, a paid resource that declared Bazaar discovery info is cataloged, and the merchant is
    // told the outcome. The payment is final by now: a catalog failure must never turn it into an error for the
    // merchant.
    if (catalog && result.success && b.paymentPayload.extensions?.bazaar) {
      let status: ReturnType<Catalog["record"]>;
      try {
        status = catalog.record(b.paymentPayload, b.paymentRequirements, undefined, result.payer);
      } catch (e) {
        log({ event: "catalog_error", error: logMessage(e) });
        status = { status: "rejected", rejectedReason: "the catalog is unavailable" };
      }
      if (status.status === "rejected") log({ event: "catalog_rejected", reason: status.rejectedReason, ...(status.detail ? { detail: status.detail } : {}) });
      // Only the status and the fixed, short reason go in the header, so it stays small for any proxy or client.
      const header = { status: status.status, ...(status.rejectedReason ? { rejectedReason: status.rejectedReason.slice(0, 100) } : {}) };
      res.set("EXTENSION-RESPONSES", Buffer.from(JSON.stringify({ bazaar: header })).toString("base64"));
    }
    res.json(result);
  });

  const num = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

  // The discovery routes exist only with discovery on.
  if (catalog) {
    app.use("/discovery", limited(discoveryLimit));

    app.get("/discovery/resources", (req, res) => {
      const q = req.query;
      res.json(catalog.list({ type: str(q.type), payTo: str(q.payTo), scheme: str(q.scheme), network: str(q.network), limit: num(q.limit), offset: num(q.offset) }));
    });

    app.get("/discovery/search", (req, res) => {
      const q = req.query;
      try {
        res.json(catalog.search({ query: str(q.query) ?? "", type: str(q.type), payTo: str(q.payTo), scheme: str(q.scheme), network: str(q.network), limit: num(q.limit) }));
      } catch (e) {
        if (!(e instanceof QueryTooLongError)) throw e;
        res.status(400).json({ error: "query_too_long", message: e.message });
      }
    });
  }

  // Errors never reach the client as stack traces or library messages, whatever NODE_ENV is.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Only errors marked for the client (body-parser's: bad JSON, too large) are the client's fault. Others with
    // a 4xx status, such as viem's HttpRequestError for an RPC answering 401 or 429, are the server's problem.
    const { status, expose } = (err ?? {}) as { status?: unknown; expose?: unknown };
    if (expose === true && typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: "invalid_request" });
      return;
    }
    log({ event: "error", error: logMessage(err) });
    res.status(500).json({ error: "internal_error" });
  });

  return { app, scheme, eoaScheme, catalog };
}
