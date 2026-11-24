import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join } from "node:path";
import { SCHEME } from "../constants.js";
import { logMessage, logToStderr } from "../decode.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { extractDiscoveryInfo, isValidIconUrl, isValidServiceName, sanitizeTags, validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";

/**
 * Validates that a resource URL is a safe public HTTPS URL.
 * Refuses non-https schemes, loopback/private/link-local/unspecified/reserved IP literals,
 * and localhost or internal/local domains (.localhost, .local, .internal).
 */
export function isSafePublicHttpsUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  let host = parsed.hostname;
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  let lower = host.toLowerCase();
  while (lower.endsWith(".")) {
    lower = lower.slice(0, -1);
  }
  if (!lower || lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return false;
  }
  const ipType = isIP(lower);
  if (ipType === 4) {
    const parts = lower.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    return !isDisallowedIpv4(parts[0], parts[1], parts[2], parts[3]);
  }
  if (ipType === 6) {
    return !isDisallowedIpv6(lower);
  }
  return true;
}

function isDisallowedIpv4(b0: number, b1: number, b2: number, b3: number): boolean {
  if (b0 === 0) return true; // 0.0.0.0/8 unspecified
  if (b0 === 10) return true; // 10.0.0.0/8 private
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (b0 === 127) return true; // 127.0.0.0/8 loopback
  if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 link-local
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12 private
  if (b0 === 192 && b1 === 0 && b2 === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (b0 === 192 && b1 === 0 && b2 === 2) return true; // 192.0.2.0/24 TEST-NET-1 documentation
  if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16 private
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true; // 198.18.0.0/15 benchmarking
  if (b0 === 198 && b1 === 51 && b2 === 100) return true; // 198.51.100.0/24 TEST-NET-2 documentation
  if (b0 === 203 && b1 === 0 && b2 === 113) return true; // 203.0.113.0/24 TEST-NET-3 documentation
  if (b0 >= 224 && b0 <= 239) return true; // 224.0.0.0/4 multicast
  if (b0 >= 240) return true; // 240.0.0.0/4 reserved / limited broadcast (including 255.255.255.255)
  return false;
}

function parseIpv6Words(raw: string): number[] | undefined {
  let ip = raw;
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  const parts = ip.split(":");
  let emptyIdx = -1;
  const words: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") {
      if (emptyIdx === -1) emptyIdx = words.length;
    } else {
      const val = parseInt(parts[i], 16);
      if (Number.isNaN(val) || val < 0 || val > 0xffff) return undefined;
      words.push(val);
    }
  }
  if (emptyIdx !== -1) {
    const missing = 8 - words.length;
    if (missing < 0) return undefined;
    const zeros = new Array(missing).fill(0);
    words.splice(emptyIdx, 0, ...zeros);
  }
  return words.length === 8 ? words : undefined;
}

function isDisallowedIpv6(raw: string): boolean {
  const words = parseIpv6Words(raw);
  if (!words) return true;
  // Unspecified ::/128
  if (words.every((w) => w === 0)) return true;
  // Loopback ::1/128
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  // IPv4-mapped ::ffff:0:0/96 (RFC 4291 §2.5.5.2)
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isDisallowedIpv4(b0, b1, b2, b3);
  }
  // IPv4-translated / SIIT ::ffff:0:0:0/96 (RFC 2765 / RFC 4291 §2.5.5.1 / RFC 6145)
  if (words.slice(0, 4).every((w) => w === 0) && words[4] === 0xffff && words[5] === 0) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isDisallowedIpv4(b0, b1, b2, b3);
  }
  // IPv4-compatible ::/96 (deprecated RFC 4291)
  if (words.slice(0, 6).every((w) => w === 0)) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    if (words[6] !== 0 || words[7] > 1) {
      return isDisallowedIpv4(b0, b1, b2, b3);
    }
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052)
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isDisallowedIpv4(b0, b1, b2, b3);
  }
  // Local-use IPv4/IPv6 translation 64:ff9b:1::/48 (RFC 8215)
  if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 1) return true;
  // 6to4 encapsulation 2002::/16 (RFC 3056)
  if (words[0] === 0x2002) {
    const b0 = (words[1] >> 8) & 0xff;
    const b1 = words[1] & 0xff;
    const b2 = (words[2] >> 8) & 0xff;
    const b3 = words[2] & 0xff;
    return isDisallowedIpv4(b0, b1, b2, b3);
  }
  // Unique local fc00::/7 (fc00::/8 and fd00::/8)
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  // Link-local unicast fe80::/10
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  // Deprecated site-local unicast fec0::/10 (RFC 3879)
  if ((words[0] & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((words[0] & 0xff00) === 0xff00) return true;
  // Discard prefix 100::/64
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;
  // Benchmarking 2001:2::/48 (RFC 5180)
  if (words[0] === 0x2001 && words[1] === 0x0002) return true;
  // Documentation 2001:db8::/32 (RFC 3849)
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
  // ORCHID 2001:10::/28 (RFC 4843)
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) return true;
  // ORCHIDv2 2001:20::/28 (RFC 7343)
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return true;
  // Teredo 2001::/32 (RFC 4380)
  if (words[0] === 0x2001 && words[1] === 0) return true;
  // Documentation 3fff::/20 (RFC 9637)
  if ((words[0] & 0xfff0) === 0x3ff0) return true;
  // Only the Global Unicast space 2000::/3 (RFC 4291 §2.4) is allocated for public Internet use;
  // all other prefixes not matched above are unallocated or reserved.
  if ((words[0] & 0xe000) !== 0x2000) return true;
  return false;
}

/** One catalog entry in the x402 Bazaar discovery format. */
export interface DiscoveryEntry {
  resource: string;
  type: string;
  x402Version: number;
  accepts: PaymentRequirements[];
  lastUpdated: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  extensions?: Record<string, unknown>;
}

export interface ListParams {
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 100;

/**
 * Limits on what a payer can put in the catalog. Anyone who settles a USDC payment of at least one atomic unit,
 * even to themselves, can add an entry, and anyone who pays a payTo can update that payTo's entry for a resource.
 * Listings are therefore untrusted; clients pay what the resource's live 402 asks.
 *
 * Self-payments (payer is payTo) never add strength. When a payTo or the catalog is full, a new entry takes the
 * place of the weakest one only if it is stronger, or if the weakest has not been paid for `staleMs`; a tie keeps
 * the incumbent. A refused entry's strength is remembered (in memory, for `staleMs`), so a real route keeps gaining
 * strength from each customer until it gets in.
 *
 * An entry's details (description, schema, listed price) come from whoever pays, so each version is scored by
 * the USDC recently paid for it (halving every `versionHalfLifeMs`), and the best-scored one is served; a tie
 * keeps the one served. Replacing a merchant's listing costs more than the route recently earned, paid to the
 * merchant, and the merchant's own new declaration takes over as its customers pay for it. How a sale was paid
 * (scheme, extra, timeout) and a dynamic route's pathParams are not part of a version; a listing shows one way to
 * pay per scheme paid in the last `staleMs`.
 *
 * - Within a payTo, strength is the USDC paid to that payTo for the entry, with no cap. Pushing out a merchant's
 *   routes costs more than they earn, and that money goes to the merchant; a new route gets in once it has earned
 *   more than the weakest listing.
 * - Across the catalog, strength is the payer count: each payer adds one per payment, up to `maxPaymentsPerPayer`,
 *   for at most `maxPayersTracked` payers (128 at most). Money cannot be used here, because payments between
 *   addresses one party controls cost that party nothing.
 */
export const CATALOG_LIMITS = {
  /** Entries kept in total. */
  maxEntries: 2_000,
  /** Entries per receiving address. */
  maxEntriesPerPayTo: 50,
  /** An entry not paid for this long is dropped. */
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  /** An entry not paid for this long can be replaced by any new entry when there is no room. */
  staleMs: 7 * 24 * 60 * 60 * 1000,
  /** Distinct payers remembered per entry. */
  maxPayersTracked: 32,
  /** Payments by one payer that add to an entry's strength. */
  maxPaymentsPerPayer: 4,
  /** Refused entries whose payers are remembered; the least recently paid is forgotten first. */
  maxPendingKeys: 2_000,
  /** Other versions of a listing kept per entry, in memory, while they compete with the one served. */
  maxAlternatives: 2,
  /** Ways to pay listed per entry: one per scheme a version was paid with, so either scheme's filter finds it. */
  maxAccepts: 2,
  /** A version's score (USDC paid for it) halves this often, so only recent payments decide what is served. */
  versionHalfLifeMs: 24 * 60 * 60 * 1000,
  /** The Bazaar extension as JSON, in characters. */
  maxExtensionChars: 4_096,
  /** A whole entry as JSON, in characters, including the payment requirements it lists. */
  maxEntryChars: 8_192,
  maxUrlChars: 2_048,
  maxDescriptionChars: 500,
  maxMimeTypeChars: 100,
  /** Search queries: total characters and words. */
  maxQueryChars: 200,
  maxQueryWords: 10,
};

/** How long a catalog change waits before it is written, so a burst of settles costs one write. */
const SAVE_DELAY_MS = 2_000;
/** After failed writes the delay doubles, up to this. */
const MAX_SAVE_DELAY_MS = 5 * 60_000;

/** A search query that breaks the limits above. */
export class QueryTooLongError extends Error {}

/** Payments counted per payer address (lowercased), each count at most CATALOG_LIMITS.maxPaymentsPerPayer. */
type Payers = Map<string, number>;
/** How an entry is ranked: by USDC paid (within one payTo) or by payer count (across the catalog). */
type Measure = "paid" | "payers";
/** A version of an entry's details and its score: USDC paid for it, decayed from `at`. */
interface Version {
  fingerprint: string;
  score: number;
  at: number;
}
/** A version competing with the served one, with its own details and the schemes it was paid with. */
interface Alternative extends Version {
  /** Unknown for a version carried over from a refused entry, until it is paid again. */
  entry?: DiscoveryEntry;
  schemesPaid: SchemesPaid;
}
/**
 * JSON for comparing declarations, not for display: object keys sorted and addresses lowercased, so the same
 * declaration with its keys in another order, or an address in another casing, compares equal. Array order counts.
 */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      // No prototype, so a "__proto__" key from JSON is an ordinary key and takes part in the comparison.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const k of Object.keys(v).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value)) ?? "";
}

/**
 * How a sale was paid, which a route offering both schemes can set per scheme: left out of a version, and kept
 * per item in a listing's accepts.
 */
function withoutPayMethod(a: PaymentRequirements): PaymentRequirements {
  return { ...a, scheme: undefined, extra: undefined, maxTimeoutSeconds: undefined } as unknown as PaymentRequirements;
}

/**
 * What identifies a version: the listing's details, not how a sale was paid. The payment time differs on every
 * sale, and a route that offers both schemes is paid with either (each with its own `extra` and timeout), so those
 * are left out; the sale's own values are what is served. (`info.input.pathParams` never reach here: normalize
 * drops them.)
 */
function fingerprint(e: DiscoveryEntry): string {
  const a = e.accepts[0];
  return canonical({ ...e, lastUpdated: undefined, accepts: a ? [withoutPayMethod(a)] : e.accepts });
}

/** When each scheme listed for a version was last paid, in ms. */
type SchemesPaid = Map<string, number>;

/**
 * The score a version starts from when it is first served without a counted payment (a self-payment, or an entry
 * stored before versions were scored): one sale at its listed price, so an unpaid-for listing is not free. It
 * then decays like any score, so a high listed price does not hold a listing once it has stopped selling.
 */
function floorOf(e: DiscoveryEntry): number {
  const amount = e.accepts[0]?.amount;
  return typeof amount === "string" && /^\d{1,40}$/.test(amount) ? Number(amount) : 0;
}
export type CatalogLog = (line: Record<string, unknown>) => void;

/**
 * A facilitator-side catalog of paid resources. An entry is added when a payment for a resource that
 * declared the Bazaar extension settles successfully, so every listing is a resource that was actually paid for.
 */
export class Catalog {
  private readonly entries = new Map<string, DiscoveryEntry>();
  /** Lowercased search text per entry, built once when the entry is stored. */
  private readonly haystacks = new Map<string, string>();
  /** Payers seen per entry: its strength across the catalog. */
  private readonly payers = new Map<string, Payers>();
  /** USDC (atomic units) paid for each entry by payers other than its payTo: its strength within the payTo. */
  private readonly paid = new Map<string, bigint>();
  /** Strength of entries refused for lack of room, so a real route can earn its place. Not persisted. */
  /**
   * Refused entries: their strength, and the decaying score of each version they were paid with (at most
   * maxAlternatives + 1), so the version that earns the entry its place starts with what it was paid while waiting.
   */
  private readonly pending = new Map<string, { payTo: string; payers: Payers; paid: bigint; lastPaid: number; versions: Version[] }>();
  /** The score of each entry's served version. */
  private readonly served = new Map<string, Version>();
  /** Other versions competing to be served, per entry. Not persisted: a restart favours the one served. */
  private readonly alternatives = new Map<string, Alternative[]>();
  /** When each scheme in a served entry's accepts was last paid, so one no longer used is dropped. */
  private readonly schemesPaid = new Map<string, SchemesPaid>();
  private saveTimer: NodeJS.Timeout | undefined;
  /** Bumped on every change; `written` is the generation on disk. */
  private generation = 0;
  private written = 0;
  private writing = false;
  private saveDelayMs = SAVE_DELAY_MS;

  /** `clock` is injectable for tests; it decides expiry on load, reads and writes. */
  constructor(
    private readonly path?: string,
    private readonly clock: () => number = Date.now,
    private readonly log: CatalogLog = logToStderr,
  ) {
    if (!path) return;
    // Temporary files left by a process that exited mid-write.
    try {
      const prefix = `${basename(path)}.`;
      for (const f of readdirSync(dirname(path))) if (f.startsWith(prefix) && f.endsWith(".tmp")) rmSync(join(dirname(path), f), { force: true });
    } catch {
      /* the directory may not exist yet */
    }
    if (!existsSync(path)) return;
    // The catalog is rebuilt by paid requests, so an unreadable file is moved aside and the catalog starts empty,
    // rather than stopping every start.
    type Stored = DiscoveryEntry & { payers?: unknown; payments?: unknown; paid?: unknown; score?: unknown; scoreAt?: unknown; schemesPaid?: unknown };
    let loaded: [string, Stored][];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the catalog file is not a JSON object");
      loaded = Object.entries(parsed as Record<string, Stored>);
    } catch (e) {
      // Each bad file is kept under its own name, so earlier evidence is not replaced.
      const aside = `${path}.corrupt-${new Date(this.clock()).toISOString().replace(/[:.]/g, "-")}`;
      let moved = true;
      try {
        renameSync(path, aside);
      } catch (moveError) {
        moved = false;
        this.log({ event: "catalog_load_failed", error: logMessage(e), moveError: logMessage(moveError), note: "the next write replaces the file" });
      }
      if (moved) this.log({ event: "catalog_load_failed", movedTo: aside, error: logMessage(e) });
      return;
    }
    const nowIso = new Date(this.clock()).toISOString();
    let rewritten = false;
    for (const [k, raw] of loaded) {
      // Dropped on load: listings saved before the key held network and payTo ("GET <url>"), which cannot be
      // told apart from a hijacked listing. Every other entry goes through the same rules as a new one, so
      // fields an earlier version kept (other extensions, long text, path-only resources) do not survive.
      // The file holds untrusted input an earlier version accepted, so a malformed entry is dropped, never thrown.
      let entry: DiscoveryEntry | undefined;
      let payers: Payers = new Map();
      let paid = 0n;
      try {
        const { payers: storedPayers, payments: _legacyCount, paid: storedPaid, score: storedScore, scoreAt: storedScoreAt, schemesPaid: storedSchemes, ...v } = raw;
        const a = v.accepts?.[0];
        if (!a || typeof a.payTo !== "string" || !k.endsWith(` ${a.network} ${a.payTo.toLowerCase()}`)) {
          rewritten = true;
          continue;
        }
        entry = normalize(v);
        // A date in the future would never expire and would sort first.
        if (entry && entry.lastUpdated > nowIso) entry.lastUpdated = nowIso;
        if (entry && JSON.stringify(entry) !== JSON.stringify(v)) rewritten = true;
        payers = loadPayers(storedPayers);
        paid = typeof storedPaid === "string" && /^\d{1,40}$/.test(storedPaid) ? BigInt(storedPaid) : 0n;
        const valid = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
        if (entry) {
          const at = valid(storedScoreAt) ? Math.min(storedScoreAt, this.clock()) : this.clock();
          // Entries from before versions were scored start from what was paid for them, at least one sale.
          this.served.set(k, { fingerprint: fingerprint(entry), score: valid(storedScore) ? storedScore : Math.max(Number(paid), floorOf(entry)), at });
          // A scheme with no stored time counts as paid when the entry last was.
          const times = storedSchemes && typeof storedSchemes === "object" ? (storedSchemes as Record<string, unknown>) : {};
          const last = Date.parse(entry.lastUpdated);
          const schemesPaid: SchemesPaid = new Map();
          for (const a of entry.accepts) {
            const t = Object.hasOwn(times, a.scheme) ? times[a.scheme] : undefined;
            schemesPaid.set(a.scheme, valid(t) ? Math.min(t, last) : last);
          }
          this.schemesPaid.set(k, schemesPaid);
        }
        // The earlier format, a list of addresses, is rewritten as counts.
        if (Array.isArray(storedPayers)) rewritten = true;
      } catch {
        entry = undefined;
      }
      if (!entry) {
        rewritten = true;
        continue;
      }
      this.put(k, entry, payers, paid);
    }
    // A file from before the limits existed can be far over them.
    this.expire();
    const byPayTo = new Map<string, string[]>();
    for (const [k, e] of this.entries) {
      const payTo = e.accepts[0]!.payTo.toLowerCase();
      let keys = byPayTo.get(payTo);
      if (!keys) byPayTo.set(payTo, (keys = []));
      keys.push(k);
    }
    for (const keys of byPayTo.values()) this.keepStrongest(keys, CATALOG_LIMITS.maxEntriesPerPayTo, "paid");
    this.keepStrongest([...this.entries.keys()], CATALOG_LIMITS.maxEntries, "payers");
    if (rewritten || this.entries.size !== loaded.length) {
      this.generation++;
      try {
        this.flush();
      } catch (e) {
        this.log({ event: "catalog_save_failed", error: logMessage(e) });
        this.scheduleSave();
      }
    }
  }

  /**
   * Catalog a settled payment made by `payer`. Returns the Bazaar status for the EXTENSION-RESPONSES header.
   * `rejectedReason` is always one of a few fixed, short strings, because it is sent to the merchant in a
   * response header; anything derived from the payer's input goes in `detail`, for the facilitator's log only.
   */
  record(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    now = new Date(this.clock()),
    payer?: string,
  ): { status: "success" | "rejected"; rejectedReason?: string; detail?: string } {
    const rejected = (rejectedReason: string, detail?: string) => ({ status: "rejected" as const, rejectedReason, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
    const ext = payload.extensions?.bazaar as { info?: { input?: { type?: unknown } } } | undefined;
    if (!ext || typeof ext !== "object") return rejected("no bazaar discovery info");
    let extJson: string;
    try {
      extJson = JSON.stringify(ext);
    } catch {
      return rejected("bazaar discovery info is not plain JSON");
    }
    if (extJson.length > CATALOG_LIMITS.maxExtensionChars) return rejected(`bazaar discovery info is over ${CATALOG_LIMITS.maxExtensionChars} characters`);
    // Only the fixed shape of the info is checked. The extension's own JSON schema comes from the payer, and
    // compiling it would run the payer's regular expressions on this process (catastrophic backtracking).
    let spec;
    try {
      spec = validateDiscoveryExtensionSpec(ext as never);
    } catch (e) {
      // The validator formats values into its messages and can throw on odd JSON (an object with toString: null).
      return rejected("invalid bazaar discovery info", e instanceof Error ? e.message : String(e));
    }
    if (!spec.valid) return rejected("invalid bazaar discovery info", spec.errors?.join(", "));
    if (ext.info?.input?.type !== "http") return rejected("only http resources are cataloged");

    let found;
    try {
      found = extractDiscoveryInfo(payload, requirements, false);
    } catch (e) {
      return rejected("invalid bazaar discovery info", e instanceof Error ? e.message : String(e));
    }
    if (!found) return rejected("no valid bazaar discovery info");
    // The schema is served to catalog consumers, and the Bazaar SDK compiles it by default: regular expressions
    // in it would run on their side.
    const schemaCheck = checkSchema((ext as { schema?: unknown }).schema);
    if (schemaCheck === "regex") return rejected("the discovery schema may not use regular expressions");
    if (schemaCheck === "too deep") return rejected("the discovery schema is nested too deeply");
    if (schemaCheck === "ref") return rejected("the discovery schema may not use references");
    const d = found as unknown as {
      resourceUrl: string;
      method?: string;
      description?: unknown;
      mimeType?: unknown;
      serviceName?: string;
      tags?: string[];
      iconUrl?: string;
      discoveryInfo?: unknown;
    };
    // resourceUrl is already canonical: the origin plus the route template, when one was declared.
    const url = d.resourceUrl;
    if (!isSafePublicHttpsUrl(url) || url.length > CATALOG_LIMITS.maxUrlChars) return rejected("the resource must be a public https URL of reasonable length");

    // The discovery info comes from the payer's payload, so the key includes who was paid: a payment to another
    // address creates its own entry. Anyone who pays this payTo can still update its entry for this resource.
    const payTo = requirements.payTo.toLowerCase();
    const key = `${d.method ?? "GET"} ${url} ${requirements.network} ${payTo}`;
    let entry: DiscoveryEntry | undefined;
    try {
      entry = normalize({
      resource: url,
      type: "http",
      x402Version: payload.x402Version,
      accepts: [requirements],
      lastUpdated: now.toISOString(),
      description: d.description as string | undefined,
      mimeType: d.mimeType as string | undefined,
      serviceName: d.serviceName,
      tags: d.tags,
      iconUrl: d.iconUrl,
        extensions: { bazaar: JSON.parse(extJson) as unknown },
      });
    } catch (e) {
      return rejected("invalid bazaar discovery info", e instanceof Error ? e.message : String(e));
    }
    if (!entry) return rejected(`the listing is over ${CATALOG_LIMITS.maxEntryChars} characters`);

    // Self-payments add an entry but never strength.
    const who = typeof payer === "string" && /^0x[0-9a-fA-F]{40}$/.test(payer) && payer.toLowerCase() !== payTo ? payer.toLowerCase() : undefined;
    const amount = who && typeof requirements.amount === "string" && /^\d{1,40}$/.test(requirements.amount) ? BigInt(requirements.amount) : 0n;
    // Expired entries go first, so they never take the place of a live one, and an expired entry for this key
    // starts again from nothing.
    this.expire(now.getTime());
    const waiting = this.entries.has(key) ? undefined : this.pending.get(key);
    const before = this.entries.has(key) ? { payers: this.payers.get(key), paid: this.paid.get(key) } : waiting;
    const fp = fingerprint(entry);
    const payers = addPayer(before?.payers ?? new Map(), who);
    const paid = (before?.paid ?? 0n) + amount;
    // A refused entry is admitted by a payment for its strongest version only, the rule a listed entry follows:
    // a weaker version's payment adds to the entry's strength but is answered rejected, and the stronger version
    // gets in with its next payment. Only the paying version's details are known, so only it can be served.
    if (waiting) {
      const t = now.getTime();
      const earnedSoFar = waiting.versions.find((v) => v.fingerprint === fp);
      const mine = (earnedSoFar ? this.decayed(earnedSoFar, t) : 0) + Number(amount);
      if (waiting.versions.some((v) => v.fingerprint !== fp && this.decayed(v, t) > mine)) {
        this.remember(key, payTo, payers, paid, t, fp, Number(amount));
        return rejected("another version of this listing has more recent payments");
      }
    }
    if (!this.entries.has(key)) {
      const samePayTo: string[] = [];
      for (const [k, e] of this.entries) if (e.accepts[0]?.payTo.toLowerCase() === payTo) samePayTo.push(k);
      if (samePayTo.length >= CATALOG_LIMITS.maxEntriesPerPayTo && !this.makeRoom(samePayTo, paid, "paid", now.getTime())) {
        if (who) this.remember(key, payTo, payers, paid, now.getTime(), fp, Number(amount));
        return rejected("no room for this payTo");
      }
      if (this.entries.size >= CATALOG_LIMITS.maxEntries && !this.makeRoom([...this.entries.keys()], BigInt(strengthOf(payers)), "payers", now.getTime())) {
        // A refusal that adds no strength (a self-payment) leaves nothing to remember, so it cannot crowd out
        // what real routes have earned while they wait.
        if (who) this.remember(key, payTo, payers, paid, now.getTime(), fp, Number(amount));
        return rejected("no room in the catalog");
      }
    }
    this.pending.delete(key);
    // A version paid for while the entry waited for room keeps what it earned.
    const earned = waiting?.versions.find((v) => v.fingerprint === fp);
    const { shown, served } = this.choose(key, entry, Number(amount), now.getTime(), earned ? this.decayed(earned, now.getTime()) : 0);
    // The other versions paid for while it waited keep competing with what they earned.
    const carried = waiting?.versions.filter((v) => v.fingerprint !== fp) ?? [];
    if (carried.length) this.keepAlternatives(key, [...(this.alternatives.get(key) ?? []), ...carried.map((v) => ({ ...v, schemesPaid: new Map() }))], now.getTime());
    this.put(key, shown, payers, paid);
    this.changed();
    if (!served) return rejected("another version of this listing has more recent payments");
    return { status: "success" };
  }

  private decayed(v: Version, now: number): number {
    return v.score * 2 ** (-Math.max(now - v.at, 0) / CATALOG_LIMITS.versionHalfLifeMs);
  }

  /**
   * Score this payment's version of the entry and return the version to serve, dated now: the best-scored one,
   * the one already served on a tie. Fewer than maxAlternatives others are kept, the lowest scored dropped.
   */
  private choose(key: string, entry: DiscoveryEntry, amount: number, now: number, earned = 0): { shown: DiscoveryEntry; served: boolean } {
    const fp = fingerprint(entry);
    const current = this.served.get(key);
    const shownEntry = this.entries.get(key);
    if (!current || !shownEntry) {
      this.served.set(key, { fingerprint: fp, score: Math.max(earned + amount, floorOf(entry)), at: now });
      this.schemesPaid.set(key, new Map([[entry.accepts[0]!.scheme, now]]));
      return { shown: entry, served: true };
    }
    if (current.fingerprint === fp) {
      this.served.set(key, { fingerprint: fp, score: this.decayed(current, now) + amount, at: now });
      const schemesPaid = this.schemesPaid.get(key) ?? new Map();
      this.schemesPaid.set(key, schemesPaid);
      return { shown: withEarlierSchemes(entry, shownEntry, schemesPaid, now), served: true };
    }
    const others = this.alternatives.get(key) ?? [];
    let mine = others.find((o) => o.fingerprint === fp);
    if (!mine) others.push((mine = { fingerprint: fp, score: 0, at: now, entry, schemesPaid: new Map() }));
    mine.score = this.decayed(mine, now) + amount;
    mine.at = now;
    mine.entry = withEarlierSchemes(entry, mine.entry ?? entry, mine.schemesPaid, now);
    const currentScore = this.decayed(current, now);
    if (mine.score > currentScore) {
      // This version takes over; the one it replaces keeps competing.
      others.splice(others.indexOf(mine), 1);
      others.push({ fingerprint: current.fingerprint, score: currentScore, at: now, entry: shownEntry, schemesPaid: this.schemesPaid.get(key) ?? new Map() });
      this.served.set(key, { fingerprint: fp, score: mine.score, at: now });
      this.schemesPaid.set(key, mine.schemesPaid);
      this.keepAlternatives(key, others, now);
      return { shown: mine.entry, served: true };
    }
    this.served.set(key, { ...current, score: currentScore, at: now });
    this.keepAlternatives(key, others, now);
    return { shown: { ...shownEntry, lastUpdated: entry.lastUpdated }, served: false };
  }

  private keepAlternatives(key: string, others: Alternative[], now: number) {
    others.sort((a, b) => this.decayed(b, now) - this.decayed(a, now));
    others.length = Math.min(others.length, CATALOG_LIMITS.maxAlternatives);
    if (others.length) this.alternatives.set(key, others);
    else this.alternatives.delete(key);
  }

  /**
   * Keep a refused entry's strength. A payTo keeps at most maxEntriesPerPayTo of them, its least paid forgotten
   * first, so junk refused at a merchant's payTo cannot push out a real route that has earned more. When the
   * total is over maxPendingKeys, the payTo with the most remembered entries loses its least recently paid one,
   * so flooding from other payTos costs those payTos their own entries first.
   */
  private remember(key: string, payTo: string, payers: Payers, paid: bigint, now: number, fp: string, amount: number) {
    const versions = this.pending.get(key)?.versions ?? [];
    let mine = versions.find((v) => v.fingerprint === fp);
    if (!mine) versions.push((mine = { fingerprint: fp, score: 0, at: now }));
    mine.score = this.decayed(mine, now) + amount;
    mine.at = now;
    versions.sort((a, b) => this.decayed(b, now) - this.decayed(a, now));
    versions.length = Math.min(versions.length, CATALOG_LIMITS.maxAlternatives + 1);
    this.pending.delete(key);
    this.pending.set(key, { payTo, payers, paid, lastPaid: now, versions });
    const byPayTo = new Map<string, string[]>();
    for (const [k, p] of this.pending) {
      let keys = byPayTo.get(p.payTo);
      if (!keys) byPayTo.set(p.payTo, (keys = []));
      keys.push(k); // in insertion order: least recently paid first
    }
    const own = byPayTo.get(payTo)!;
    if (own.length > CATALOG_LIMITS.maxEntriesPerPayTo) {
      let weakest = own[0]!;
      for (const k of own) if (this.pending.get(k)!.paid < this.pending.get(weakest)!.paid) weakest = k;
      this.pending.delete(weakest);
      own.splice(own.indexOf(weakest), 1);
    }
    if (this.pending.size > CATALOG_LIMITS.maxPendingKeys) {
      // The payTos with the most remembered entries give one up: the least paid among them, the least recently
      // paid among equals. When every payTo has one, that is the least paid overall, never simply the oldest, so
      // cheap entries cannot push out a route that has earned more.
      let most = 0;
      for (const keys of byPayTo.values()) most = Math.max(most, keys.length);
      let victim: string | undefined;
      for (const keys of byPayTo.values()) {
        if (keys.length !== most) continue;
        for (const k of keys) if (victim === undefined || this.pending.get(k)!.paid < this.pending.get(victim)!.paid) victim = k;
      }
      this.pending.delete(victim!);
    }
  }

  private put(key: string, entry: DiscoveryEntry, payers: Payers, paid: bigint) {
    this.entries.set(key, entry);
    this.haystacks.set(key, haystack(entry));
    this.payers.set(key, payers);
    this.paid.set(key, paid);
  }

  private remove(key: string) {
    this.entries.delete(key);
    this.haystacks.delete(key);
    this.payers.delete(key);
    this.paid.delete(key);
    this.served.delete(key);
    this.alternatives.delete(key);
    this.schemesPaid.delete(key);
  }

  /** Payer-count strength, used across the catalog. */
  private strength(key: string): number {
    return strengthOf(this.payers.get(key));
  }

  private measure(key: string, m: Measure): bigint {
    return m === "paid" ? (this.paid.get(key) ?? 0n) : BigInt(this.strength(key));
  }

  /**
   * Free one slot among `keys` for a newcomer of strength `newcomer` (in measure `m`): the weakest entry goes if
   * the newcomer is stronger, or if that entry has not been paid for staleMs. Returns false, changing nothing,
   * when it is not.
   */
  private makeRoom(keys: string[], newcomer: bigint, m: Measure, now: number): boolean {
    let weakest: string | undefined;
    for (const k of keys) if (weakest === undefined || this.weaker(k, weakest, m)) weakest = k;
    if (weakest === undefined) return true;
    const stale = (this.entries.get(weakest)?.lastUpdated ?? "") < new Date(now - CATALOG_LIMITS.staleMs).toISOString();
    if (!stale && newcomer <= this.measure(weakest, m)) return false;
    this.remove(weakest);
    return true;
  }

  /** Whether entry a ranks below entry b in measure `m`: less strength, then less recently paid. */
  private weaker(a: string, b: string, m: Measure): boolean {
    const x = this.measure(a, m);
    const y = this.measure(b, m);
    if (x !== y) return x < y;
    return (this.entries.get(a)?.lastUpdated ?? "") < (this.entries.get(b)?.lastUpdated ?? "");
  }

  /** Drop entries not paid for within maxAgeMs. Runs on load, on every record and on every read. */
  private expire(now = this.clock()) {
    const cutoff = new Date(now - CATALOG_LIMITS.maxAgeMs).toISOString();
    let removed = false;
    for (const [k, e] of this.entries) {
      if (e.lastUpdated < cutoff) {
        this.remove(k);
        removed = true;
      }
    }
    if (removed) this.changed();
    for (const [k, p] of this.pending) if (p.lastPaid < now - CATALOG_LIMITS.staleMs) this.pending.delete(k);
  }

  /** Of `keys`, keep the `keep` strongest in measure `m` (then most recently paid) and drop the rest. */
  private keepStrongest(keys: string[], keep: number, m: Measure) {
    if (keys.length <= keep) return;
    const sorted = keys.sort((a, b) => (this.weaker(a, b, m) ? 1 : this.weaker(b, a, m) ? -1 : 0));
    for (const k of sorted.slice(keep)) this.remove(k);
  }

  private matches(e: DiscoveryEntry, p: Omit<ListParams, "limit" | "offset">): boolean {
    if (p.type && e.type !== p.type) return false;
    return e.accepts.some(
      (a) =>
        (!p.payTo || a.payTo.toLowerCase() === p.payTo.toLowerCase()) &&
        (!p.scheme || a.scheme === p.scheme) &&
        (!p.network || a.network === p.network),
    );
  }

  private sorted(): DiscoveryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  }

  list(p: ListParams) {
    this.expire();
    const limit = Math.min(Math.max(p.limit ?? 20, 1), MAX_LIMIT);
    const offset = Math.max(p.offset ?? 0, 0);
    const all = this.sorted().filter((e) => this.matches(e, p));
    return { x402Version: 2, items: all.slice(offset, offset + limit), pagination: { limit, offset, total: all.length } };
  }

  /** Throws QueryTooLongError when the query breaks CATALOG_LIMITS. */
  search(p: ListParams & { query: string }) {
    const limit = Math.min(Math.max(p.limit ?? 20, 1), MAX_LIMIT);
    const q = p.query.trim().toLowerCase();
    const words = q === "" ? [] : q.split(/\s+/);
    if (q.length > CATALOG_LIMITS.maxQueryChars || words.length > CATALOG_LIMITS.maxQueryWords) {
      throw new QueryTooLongError(`a query is at most ${CATALOG_LIMITS.maxQueryChars} characters and ${CATALOG_LIMITS.maxQueryWords} words`);
    }
    this.expire();
    const found: DiscoveryEntry[] = [];
    for (const [k, e] of this.entries) {
      if (!this.matches(e, p)) continue;
      const hay = this.haystacks.get(k) ?? "";
      if (words.every((w) => hay.includes(w))) found.push(e);
    }
    found.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
    return { x402Version: 2, resources: found.slice(0, limit), partialResults: found.length > limit, pagination: null };
  }

  /** Write pending changes now, synchronously. Call it just before the process exits. */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.path || this.written === this.generation) return;
    const generation = this.generation;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.sync.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, this.serialize());
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    syncDir(this.path);
    this.written = generation;
  }

  private changed() {
    this.generation++;
    this.scheduleSave();
  }

  private scheduleSave() {
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.writeInBackground();
    }, this.saveDelayMs);
    this.saveTimer.unref();
  }

  /** Writes off the event loop; an older write never replaces a newer one. */
  private async writeInBackground() {
    if (!this.path) return;
    if (this.writing) return this.scheduleSave();
    this.writing = true;
    // The snapshot and its generation are taken together, before any await.
    const generation = this.generation;
    const json = this.serialize();
    const tmp = `${this.path}.${generation}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      // Synced before the rename, so a power loss leaves either the old file or the new one.
      const file = await open(tmp, "w");
      try {
        await file.writeFile(json);
        await file.sync();
      } finally {
        await file.close();
      }
      // The check and the rename run in one synchronous step, so a flush() (at shutdown) can never land
      // between them, and an older snapshot can never replace a newer one.
      if (generation > this.written) {
        renameSync(tmp, this.path);
        this.written = generation;
        await syncDirAsync(this.path);
      } else await rm(tmp, { force: true });
      this.saveDelayMs = SAVE_DELAY_MS;
    } catch (e) {
      // The catalog is rebuilt by later paid requests; a failed write must not take the facilitator down.
      // Retries back off, so a read-only or full disk costs a log line every few minutes, not every 2 s.
      this.saveDelayMs = Math.min(this.saveDelayMs * 2, MAX_SAVE_DELAY_MS);
      this.log({ event: "catalog_save_failed", retryInMs: this.saveDelayMs, error: logMessage(e) });
      await rm(tmp, { force: true }).catch(() => {});
    } finally {
      this.writing = false;
      if (this.generation > this.written) this.scheduleSave();
    }
  }

  private serialize(): string {
    const out: Record<string, DiscoveryEntry & { payers: Record<string, number>; paid: string; score: number; scoreAt: number; schemesPaid: Record<string, number> }> = {};
    for (const [k, e] of this.entries) {
      const v = this.served.get(k);
      out[k] = { ...e, payers: Object.fromEntries(this.payers.get(k) ?? []), paid: String(this.paid.get(k) ?? 0n), score: v?.score ?? 0, scoreAt: v?.at ?? 0, schemesPaid: Object.fromEntries(this.schemesPaid.get(k) ?? []) };
    }
    return JSON.stringify(out);
  }
}

function strengthOf(payers: Payers | undefined): number {
  let n = 0;
  for (const c of payers?.values() ?? []) n += c;
  return n;
}

/** `payers` plus one payment by `who`, within the limits; a new map, so a refused record changes nothing stored. */
function addPayer(payers: Payers, who: string | undefined): Payers {
  const out = new Map(payers);
  if (!who) return out;
  const n = out.get(who);
  if (n !== undefined) out.set(who, Math.min(n + 1, CATALOG_LIMITS.maxPaymentsPerPayer));
  else if (out.size < CATALOG_LIMITS.maxPayersTracked) out.set(who, 1);
  return out;
}

/** Stored payers: `{ address: count }`, or the earlier list of addresses (one payment each). Anything else is dropped. */
function loadPayers(stored: unknown): Payers {
  const out: Payers = new Map();
  const pairs: [unknown, unknown][] = Array.isArray(stored)
    ? stored.map((a) => [a, 1])
    : stored && typeof stored === "object"
      ? Object.entries(stored)
      : [];
  for (const [a, n] of pairs) {
    if (out.size >= CATALOG_LIMITS.maxPayersTracked) break;
    if (typeof a !== "string" || !/^0x[0-9a-f]{40}$/.test(a) || !Number.isInteger(n) || (n as number) < 1) continue;
    out.set(a, Math.min(n as number, CATALOG_LIMITS.maxPaymentsPerPayer));
  }
  return out;
}

/** Keywords whose value is one subschema, a list of them, or a map of them (JSON Schema draft 4 to 2020-12). */
const ONE_SCHEMA = ["additionalItems", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties", "contentSchema", "items"];
const SCHEMA_LIST = ["allOf", "anyOf", "oneOf", "prefixItems", "items"];
const SCHEMA_MAP = ["properties", "definitions", "$defs", "dependentSchemas", "dependencies"];
const MAX_SCHEMA_DEPTH = 32;
const REFERENCE_KEYWORDS = ["$ref", "$dynamicRef", "$recursiveRef", "$id", "$anchor", "$dynamicAnchor", "$recursiveAnchor"];


/**
 * Whether a JSON schema uses a regular expression (`pattern` or `patternProperties`) in a schema position. Only
 * schema positions are walked, so a property named "pattern", or a `default` or example value holding one, is fine.
 * References are refused altogether: a `$ref` can point anywhere in the document, including into a `default`
 * value, and a chain of `$defs` that each reference the previous one twice is exponential for a validator. The
 * Bazaar SDK's own declarations use none.
 */
function checkSchema(schema: unknown, depth = 0): "ok" | "regex" | "too deep" | "ref" {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "ok";
  if (depth > MAX_SCHEMA_DEPTH) return "too deep";
  const s = schema as Record<string, unknown>;
  if (typeof s.pattern === "string" || s.patternProperties !== undefined) return "regex";
  for (const k of REFERENCE_KEYWORDS) if (s[k] !== undefined) return "ref";
  const subschemas: unknown[] = [];
  for (const k of ONE_SCHEMA) if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) subschemas.push(s[k]);
  for (const k of SCHEMA_LIST) if (Array.isArray(s[k])) subschemas.push(...(s[k] as unknown[]));
  for (const k of SCHEMA_MAP) if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) subschemas.push(...Object.values(s[k] as object));
  for (const sub of subschemas) {
    const r = checkSchema(sub, depth + 1);
    if (r !== "ok") return r;
  }
  return "ok";
}

/**
 * Characters that can change what a reader sees without showing: control characters, bidirectional overrides,
 * zero-width characters and the Unicode line and paragraph separators.
 */
const UNSAFE_TEXT = /[\p{Cc}\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?: *; *[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Keep the payment requirements needed by a listing. Preserve the checked UserOperation EntryPoint
 * and the optional upfront flow alongside the standard fields.
 */
function pickRequirements(r: PaymentRequirements): PaymentRequirements {
  const { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra } = r;
  const kept: Record<string, unknown> = {};
  const entryPoint = extra?.entryPoint;
  if (scheme === SCHEME && typeof entryPoint === "string" && /^0x[0-9a-fA-F]{40}$/.test(entryPoint)) {
    kept.entryPoint = entryPoint;
  }
  if (extra?.paymentFlow === "upfront") kept.paymentFlow = "upfront";
  const listed = { scheme, network, asset, amount, payTo, maxTimeoutSeconds };
  return (Object.keys(kept).length ? { ...listed, extra: kept } : listed) as PaymentRequirements;
}

/**
 * The accepts of one listing: the first item, then one item per other scheme that differs from it only in how a
 * sale was paid (scheme, extra, timeout), at most maxAccepts. Anything else belongs to another version and is
 * not kept.
 */
function sameListing(items: PaymentRequirements[]): PaymentRequirements[] {
  const listing = (a: PaymentRequirements) => canonical(withoutPayMethod(a));
  const out: PaymentRequirements[] = [];
  for (const a of items) {
    if (out.length >= CATALOG_LIMITS.maxAccepts) break;
    if (typeof a.scheme !== "string" || out.some((o) => o.scheme === a.scheme)) continue;
    if (out.length && listing(a) !== listing(out[0]!)) continue;
    out.push(a);
  }
  return out;
}

/**
 * A sale's entry, listing first the way it was paid and then the other schemes the same version was paid with
 * in the last `staleMs`, so a route that offers both schemes is found by either scheme's filter whichever was used
 * last, and a scheme no longer used drops out. The earlier ones are also dropped if they would put the entry over
 * its size budget. Records this sale in `schemesPaid`, which keeps only the schemes listed.
 */
function withEarlierSchemes(entry: DiscoveryEntry, earlier: DiscoveryEntry, schemesPaid: SchemesPaid, now: number): DiscoveryEntry {
  schemesPaid.set(entry.accepts[0]!.scheme, now);
  const recent = earlier.accepts.filter((a) => (schemesPaid.get(a.scheme) ?? 0) > now - CATALOG_LIMITS.staleMs);
  let merged = { ...entry, accepts: sameListing([...entry.accepts, ...recent]) };
  if (JSON.stringify(merged).length > CATALOG_LIMITS.maxEntryChars) merged = entry;
  for (const scheme of [...schemesPaid.keys()]) if (!merged.accepts.some((a) => a.scheme === scheme)) schemesPaid.delete(scheme);
  return merged;
}

/**
 * The catalog's rules for one entry, for new and loaded entries alike: an absolute http(s) resource, bounded
 * text, sanitized service metadata, only the Bazaar extension, only the listed requirements' known fields,
 * and a whole-entry size budget. Returns undefined for an entry that cannot be kept.
 */
function normalize(e: DiscoveryEntry): DiscoveryEntry | undefined {
  const text = (v: unknown, max: number) => (typeof v === "string" && v.length <= max && !UNSAFE_TEXT.test(v) ? v : undefined);
  const a = e.accepts?.[0];
  if (!a || typeof e.resource !== "string" || typeof e.lastUpdated !== "string") return undefined;
  if (!ISO_DATE.test(e.lastUpdated) || Number.isNaN(Date.parse(e.lastUpdated))) return undefined;
  if (!isSafePublicHttpsUrl(e.resource) || e.resource.length > CATALOG_LIMITS.maxUrlChars) return undefined;
  const bazaar = (e.extensions as { bazaar?: unknown } | undefined)?.bazaar;
  if (bazaar !== undefined) {
    // The same fixed-shape, http-only rules as a new record, so stored declarations from an earlier version
    // (an MCP tool, say) are not kept under type "http".
    if (!bazaar || typeof bazaar !== "object" || JSON.stringify(bazaar).length > CATALOG_LIMITS.maxExtensionChars) return undefined;
    if (!validateDiscoveryExtensionSpec(bazaar as never).valid) return undefined;
    if ((bazaar as { info?: { input?: { type?: unknown } } }).info?.input?.type !== "http") return undefined;
    if (checkSchema((bazaar as { schema?: unknown }).schema) !== "ok") return undefined;
  }
  // A dynamic route's pathParams are one request's values, not the route's: they are not kept.
  const input = (bazaar as { info?: { input?: Record<string, unknown> } } | undefined)?.info?.input;
  const declared = input && "pathParams" in input ? (() => {
    const { pathParams: _request, ...rest } = input;
    const b = bazaar as { info: Record<string, unknown> };
    return { ...b, info: { ...b.info, input: rest } };
  })() : bazaar;
  const mimeType = text(e.mimeType, CATALOG_LIMITS.maxMimeTypeChars);
  const out: DiscoveryEntry = {
    resource: e.resource,
    type: "http",
    x402Version: e.x402Version,
    accepts: sameListing(e.accepts.filter((x) => x && typeof x === "object").map(pickRequirements)),
    lastUpdated: e.lastUpdated,
    // Line breaks and tabs in a description become spaces; other invisible characters drop the field.
    description: text(typeof e.description === "string" ? e.description.replace(/[\t\n\r\u2028\u2029]+/g, " ") : e.description, CATALOG_LIMITS.maxDescriptionChars),
    mimeType: mimeType && MIME_TYPE.test(mimeType) ? mimeType : undefined,
    serviceName: isValidServiceName(e.serviceName) ? e.serviceName : undefined,
    tags: sanitizeTags(e.tags),
    iconUrl: isValidIconUrl(e.iconUrl) ? e.iconUrl : undefined,
    extensions: declared === undefined ? undefined : { bazaar: declared },
  };
  for (const k of Object.keys(out) as (keyof DiscoveryEntry)[]) if (out[k] === undefined) delete out[k];
  if (!out.accepts.length) return undefined;
  return JSON.stringify(out).length <= CATALOG_LIMITS.maxEntryChars ? out : undefined;
}

function haystack(e: DiscoveryEntry): string {
  return [e.resource, e.description, e.serviceName, ...(e.tags ?? [])].filter((v) => typeof v === "string").join(" ").toLowerCase();
}

/** Makes a rename in the file's directory durable. Not every platform can open a directory, so it is best effort. */
function syncDir(path: string) {
  try {
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    /* best effort */
  }
}

async function syncDirAsync(path: string) {
  try {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* best effort */
  }
}
