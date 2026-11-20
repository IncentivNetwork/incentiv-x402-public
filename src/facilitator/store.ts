import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
/**
 * A result older than this is forgotten. Results are only checked for existence, and a forgotten one is still
 * never a success again: its payment is on chain without a claim (`already_settled`), or, if the receipt can no
 * longer be found, long past its deadline (`payment_expired`).
 */
export const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The claim time recorded for a payment that succeeded but whose result could not be recorded: dated in the
 * future, so the claim lasts RESULT_TTL_MS instead of CLAIM_TTL_MS, and the payment can still be reported once
 * when storage works again. After that its result would have been forgotten anyway.
 */
const pinnedAt = (now: number) => now + RESULT_TTL_MS - CLAIM_TTL_MS;

export interface SettledStore {
  get(hash: string): SettleResponse | undefined;
  set(hash: string, result: SettleResponse): void;
  claim(hash: string): void;
  isClaimed(hash: string): boolean;
  release(hash: string): void;
}

/**
 * Every change is persisted before it counts: if the write fails, the in-memory change is rolled back and the
 * error is thrown, so memory never holds a result or claim that the file does not.
 */
export class MemoryStore implements SettledStore {
  protected readonly results = new Map<string, SettleResponse>();
  protected readonly claims = new Map<string, number>(); // hash -> time claimed (ms)
  protected readonly settledAt = new Map<string, number>(); // hash -> time the result was recorded (ms)
  get(hash: string) {
    return this.results.get(hash.toLowerCase());
  }
  set(hash: string, result: SettleResponse) {
    const k = hash.toLowerCase();
    const claimedAt = this.claims.get(k);
    const previous = this.results.get(k);
    const previousAt = this.settledAt.get(k);
    this.prune();
    this.results.set(k, result);
    this.settledAt.set(k, Date.now());
    this.claims.delete(k);
    try {
      this.save();
    } catch (e) {
      if (previous === undefined) this.results.delete(k);
      else this.results.set(k, previous);
      if (previousAt === undefined) this.settledAt.delete(k);
      else this.settledAt.set(k, previousAt);
      if (claimedAt !== undefined) {
        if (result.success) {
          // The payment executed, so the CLAIM_TTL_MS reasoning (an old claim never landed) no longer holds: the
          // claim is kept as long as a result would be. The pin is written as soon as a write succeeds.
          this.claims.set(k, pinnedAt(Date.now()));
          try {
            this.save();
          } catch {
            /* still failing; the pin is kept in memory */
          }
        } else {
          // A failure is never reported as a success, so it needs no pin; the claim is restored as it was.
          this.claims.set(k, claimedAt);
        }
      }
      throw e;
    }
  }
  claim(hash: string) {
    const k = hash.toLowerCase();
    this.prune();
    const before = this.claims.get(k);
    this.claims.set(k, Date.now());
    try {
      this.save();
    } catch (e) {
      if (before === undefined) this.claims.delete(k);
      else this.claims.set(k, before);
      throw e;
    }
  }
  isClaimed(hash: string) {
    const at = this.claims.get(hash.toLowerCase());
    return at !== undefined && Date.now() - at < CLAIM_TTL_MS;
  }
  /** Drops expired claims and old results from memory; the next write drops them from the file. */
  protected prune() {
    const now = Date.now();
    for (const [k, at] of this.claims) if (at <= now - CLAIM_TTL_MS) this.claims.delete(k);
    for (const [k, at] of this.settledAt) {
      if (at <= now - RESULT_TTL_MS) {
        this.settledAt.delete(k);
        this.results.delete(k);
      }
    }
  }
  release(hash: string) {
    const k = hash.toLowerCase();
    const at = this.claims.get(k);
    if (at === undefined) return;
    this.claims.delete(k);
    try {
      this.save();
    } catch (e) {
      this.claims.set(k, at);
      throw e;
    }
  }
  protected save() {}
}

/**
 * A JSON file, rewritten atomically on each change and synced to disk before the rename, so a power loss leaves
 * either the old file or the new one. Enough for the single facilitator process.
 */
export class FileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super();
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      settled?: Record<string, SettleResponse>;
      settledAt?: Record<string, number>;
      claims?: string[] | Record<string, number>;
    } & Record<string, unknown>;
    // Earlier versions stored the results map at the top level.
    const settled = (data.settled ?? (data.claims ? {} : data)) as Record<string, SettleResponse>;
    // Results from before timestamps were kept count as recorded now, so they are kept for a full RESULT_TTL_MS.
    const loadedAt = Date.now();
    for (const [k, v] of Object.entries(settled)) {
      this.results.set(k, v);
      const at = data.settledAt?.[k];
      this.settledAt.set(k, typeof at === "number" && Number.isFinite(at) ? at : loadedAt);
    }
    // Claims were a list of hashes in an earlier version; they count as claimed now.
    if (Array.isArray(data.claims)) for (const k of data.claims) this.claims.set(k, Date.now());
    // An earlier version pinned claims forever (Number.MAX_SAFE_INTEGER); they now last RESULT_TTL_MS from here.
    // A claim time that is not a number cannot be trusted or expired; it counts as claimed now.
    else for (const [k, at] of Object.entries(data.claims ?? {})) this.claims.set(k, typeof at === "number" && Number.isFinite(at) ? Math.min(at, pinnedAt(loadedAt)) : loadedAt);
    this.prune();
  }
  protected override save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      // writeFileSync keeps writing after a short write; a single writeSync call would not.
      writeFileSync(fd, JSON.stringify({ settled: Object.fromEntries(this.results), settledAt: Object.fromEntries(this.settledAt), claims: Object.fromEntries(this.claims) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // The rename itself is durable once the directory is synced. Not every platform can open a directory.
    try {
      const dir = openSync(dirname(this.path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      /* best effort */
    }
  }
}
