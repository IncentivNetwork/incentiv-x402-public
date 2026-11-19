import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SettleResponse } from "@x402/core/types";

/**
 * What the facilitator remembers about payments, by transaction or user operation hash.
 *
 * - A **claim** is written just before the facilitator submits a payment. A receipt found later is reported
 *   as a success only if this facilitator holds the claim, so a payment that was submitted elsewhere, or
 *   whose record was lost, is never reported as a success for a new request.
 * - A **result** is the final answer once the payment executed or reverted. A result exists only once.
 *
 * Without persistence a restart forgets claims, so a settle that timed out before the restart is then
 * refused rather than reported twice. Production facilitators must use a persistent store.
 */
/**
 * A claim older than this is forgotten. A payment's deadline is at most 300 s away and a settle waits for a
 * receipt for far less than the rest of this hour, so an older claim belongs to a payment that never landed.
 */
export const CLAIM_TTL_MS = 60 * 60 * 1000;

export interface SettledStore {
  get(hash: string): SettleResponse | undefined;
  set(hash: string, result: SettleResponse): void;
  claim(hash: string): void;
  isClaimed(hash: string): boolean;
  release(hash: string): void;
}

export class MemoryStore implements SettledStore {
  protected readonly results = new Map<string, SettleResponse>();
  protected readonly claims = new Map<string, number>(); // hash -> time claimed (ms)
  get(hash: string) {
    return this.results.get(hash.toLowerCase());
  }
  set(hash: string, result: SettleResponse) {
    this.results.set(hash.toLowerCase(), result);
    this.claims.delete(hash.toLowerCase());
    this.save();
  }
  claim(hash: string) {
    this.prune();
    this.claims.set(hash.toLowerCase(), Date.now());
    this.save();
  }
  isClaimed(hash: string) {
    const at = this.claims.get(hash.toLowerCase());
    return at !== undefined && Date.now() - at < CLAIM_TTL_MS;
  }
  protected prune() {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const [k, at] of this.claims) if (at <= cutoff) this.claims.delete(k);
  }
  release(hash: string) {
    if (this.claims.delete(hash.toLowerCase())) this.save();
  }
  protected save() {}
}

/** A JSON file, rewritten atomically on each change. Enough for the single facilitator process. */
export class FileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super();
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as { settled?: Record<string, SettleResponse>; claims?: string[] | Record<string, number> } & Record<string, unknown>;
    // Earlier versions stored the results map at the top level.
    const settled = (data.settled ?? (data.claims ? {} : data)) as Record<string, SettleResponse>;
    for (const [k, v] of Object.entries(settled)) this.results.set(k, v);
    // Claims were a list of hashes in an earlier version; they count as claimed now.
    if (Array.isArray(data.claims)) for (const k of data.claims) this.claims.set(k, Date.now());
    else for (const [k, at] of Object.entries(data.claims ?? {})) this.claims.set(k, at);
    this.prune();
  }
  protected override save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ settled: Object.fromEntries(this.results), claims: Object.fromEntries(this.claims) }));
    renameSync(tmp, this.path);
  }
}
