import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { extractDiscoveryInfo } from "@x402/extensions/bazaar";

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
 * A facilitator-side catalog of paid resources. An entry is added when a payment for a resource that
 * declared the Bazaar extension settles successfully, so every listing is a resource that was actually paid for.
 */
export class Catalog {
  private readonly entries = new Map<string, DiscoveryEntry>();

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, DiscoveryEntry>)) this.entries.set(k, v);
    }
  }

  /** Catalog a settled payment. Returns the Bazaar status for the EXTENSION-RESPONSES header. */
  record(payload: PaymentPayload, requirements: PaymentRequirements, now = new Date()): { status: "success" | "rejected"; rejectedReason?: string } {
    let found;
    try {
      found = extractDiscoveryInfo(payload, requirements, true);
    } catch (e) {
      return { status: "rejected", rejectedReason: e instanceof Error ? e.message : "invalid discovery info" };
    }
    if (!found) return { status: "rejected", rejectedReason: "no valid bazaar discovery info" };
    const d = found as unknown as {
      resourceUrl: string;
      method?: string;
      routeTemplate?: string;
      description?: string;
      mimeType?: string;
      serviceName?: string;
      tags?: string[];
      iconUrl?: string;
      extensions?: Record<string, unknown>;
      discoveryInfo?: unknown;
    };
    const url = d.routeTemplate ?? d.resourceUrl;
    // The discovery info comes from the payer's payload, so the key includes who was paid: a payment to
    // another address creates its own entry and can never replace a merchant's listing.
    const key = `${d.method ?? "GET"} ${url} ${requirements.network} ${requirements.payTo.toLowerCase()}`;
    this.entries.set(key, {
      resource: url,
      type: "http",
      x402Version: payload.x402Version,
      accepts: [requirements],
      lastUpdated: now.toISOString(),
      description: d.description,
      mimeType: d.mimeType,
      serviceName: d.serviceName,
      tags: d.tags,
      iconUrl: d.iconUrl,
      extensions: d.extensions ?? { bazaar: { info: d.discoveryInfo } },
    });
    this.save();
    return { status: "success" };
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
    const limit = Math.min(Math.max(p.limit ?? 20, 1), MAX_LIMIT);
    const offset = Math.max(p.offset ?? 0, 0);
    const all = this.sorted().filter((e) => this.matches(e, p));
    return { x402Version: 2, items: all.slice(offset, offset + limit), pagination: { limit, offset, total: all.length } };
  }

  search(p: ListParams & { query: string }) {
    const limit = Math.min(Math.max(p.limit ?? 20, 1), MAX_LIMIT);
    const q = p.query.trim().toLowerCase();
    const hay = (e: DiscoveryEntry) => [e.resource, e.description, e.serviceName, ...(e.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
    const found = this.sorted().filter((e) => this.matches(e, p) && (q === "" || q.split(/\s+/).every((w) => hay(e).includes(w))));
    return { x402Version: 2, resources: found.slice(0, limit), partialResults: found.length > limit, pagination: null };
  }

  private save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
    renameSync(tmp, this.path);
  }
}
