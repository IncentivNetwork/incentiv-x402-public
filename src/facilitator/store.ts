import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SettleResponse } from "@x402/core/types";
import type { Hex } from "viem";
import type { OperationCheckpoint } from "./operation-history.js";

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
 * A claim made without marking a submission attempt expires after an hour.
 */
export const CLAIM_TTL_MS = 60 * 60 * 1000;
/**
 * A result older than this is forgotten. Results are only checked for existence, and a forgotten one is still
 * never a success again: its payment is on chain without a claim (`already_settled`), or, if the receipt can no
 * longer be found, long past its deadline (`payment_expired`).
 */
export const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Allow the receipt lookup to catch up after the first observation of a confirmed nonce advance. */
export const NONCE_USED_GRACE_MS = 2 * 60 * 1000;
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
  /** Durably retain a submission attempt for RESULT_TTL_MS without refreshing its lifetime on a resend. */
  claimForSubmission(hash: string): void;
  isClaimed(hash: string): boolean;
  isSubmitted(hash: string): boolean;
  /** Start grace on a confirmed advance. An unused reading or a store restart invalidates the old observation. */
  nonceUsedPastGrace(hash: string, used: boolean, now: number): boolean;
  getOperationCheckpoint?(hash: string): OperationCheckpoint | undefined;
  saveOperationCheckpoint?(hash: string, checkpoint: OperationCheckpoint): void;
  release(hash: string): void;
}

export function settlementStore(store: SettledStore = new MemoryStore()): SettledStore {
  if (typeof store.claimForSubmission !== "function" ||
      typeof store.isSubmitted !== "function" ||
      typeof store.nonceUsedPastGrace !== "function") {
    throw new TypeError("SettledStore must support durable submission claims and nonce recovery");
  }
  return store;
}

/**
 * Results and claims count after a successful save. A failed grace reset still invalidates the old
 * observation in memory so a later retry must persist a new observation before it can finalize.
 */
export class MemoryStore implements SettledStore {
  protected readonly results = new Map<string, SettleResponse>();
  protected readonly claims = new Map<string, number>(); // hash -> time claimed (ms)
  protected readonly submitted = new Map<string, number | null>(); // hash -> first confirmed nonce use, if observed
  protected readonly settledAt = new Map<string, number>(); // hash -> time the result was recorded (ms)
  protected readonly operationCheckpoints = new Map<string, OperationCheckpoint>();
  get(hash: string) {
    return this.results.get(hash.toLowerCase());
  }
  set(hash: string, result: SettleResponse) {
    const k = hash.toLowerCase();
    const claimedAt = this.claims.get(k);
    const previous = this.results.get(k);
    const previousAt = this.settledAt.get(k);
    this.prune();
    const nonceUsedAt = this.submitted.get(k);
    const checkpoint = this.operationCheckpoints.get(k);
    this.results.set(k, result);
    this.settledAt.set(k, Date.now());
    this.claims.delete(k);
    this.submitted.delete(k);
    this.operationCheckpoints.delete(k);
    try {
      this.save();
    } catch (e) {
      if (previous === undefined) this.results.delete(k);
      else this.results.set(k, previous);
      if (previousAt === undefined) this.settledAt.delete(k);
      else this.settledAt.set(k, previousAt);
      if (claimedAt !== undefined) {
        if (nonceUsedAt !== undefined) this.submitted.set(k, nonceUsedAt);
        if (checkpoint !== undefined) this.operationCheckpoints.set(k, checkpoint);
        if (result.success) {
          // Keep the claim as long as a result would be after observing success.
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
    this.saveClaim(hash, false);
  }
  claimForSubmission(hash: string) {
    this.saveClaim(hash, true);
  }
  private saveClaim(hash: string, submitted: boolean) {
    const k = hash.toLowerCase();
    this.prune();
    if (this.submitted.has(k)) return;
    const before = this.claims.get(k);
    const now = Date.now();
    this.claims.set(k, submitted ? pinnedAt(now) : now);
    if (submitted) this.submitted.set(k, null);
    try {
      this.save();
    } catch (e) {
      this.submitted.delete(k);
      if (before === undefined) this.claims.delete(k);
      else this.claims.set(k, before);
      throw e;
    }
  }
  isClaimed(hash: string) {
    const at = this.claims.get(hash.toLowerCase());
    return at !== undefined && Date.now() - at < CLAIM_TTL_MS;
  }
  isSubmitted(hash: string) {
    return this.isClaimed(hash) && this.submitted.has(hash.toLowerCase());
  }
  nonceUsedPastGrace(hash: string, used: boolean, now: number) {
    const k = hash.toLowerCase();
    const at = this.submitted.get(k);
    if (at === undefined || !this.isClaimed(k)) return false;
    const next = used ? (at ?? now) : null;
    if (next !== at) {
      this.submitted.set(k, next);
      try {
        this.save();
      } catch (e) {
        if (used) this.submitted.set(k, at);
        throw e;
      }
    }
    return next !== null && now - next >= NONCE_USED_GRACE_MS;
  }
  getOperationCheckpoint(hash: string) {
    return this.isSubmitted(hash) ? this.operationCheckpoints.get(hash.toLowerCase()) : undefined;
  }
  saveOperationCheckpoint(hash: string, checkpoint: OperationCheckpoint) {
    const key = hash.toLowerCase();
    this.prune();
    if (!this.isSubmitted(key)) return;
    const before = this.operationCheckpoints.get(key);
    this.operationCheckpoints.set(key, checkpoint);
    try {
      this.save();
    } catch (e) {
      if (before) this.operationCheckpoints.set(key, before);
      else this.operationCheckpoints.delete(key);
      throw e;
    }
  }
  /** Drops expired claims and old results from memory; the next write drops them from the file. */
  protected prune() {
    const now = Date.now();
    for (const [k, at] of this.claims) {
      if (at > now - CLAIM_TTL_MS) continue;
      this.claims.delete(k);
      this.submitted.delete(k);
      this.operationCheckpoints.delete(k);
    }
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
    const nonceUsedAt = this.submitted.get(k);
    const checkpoint = this.operationCheckpoints.get(k);
    this.claims.delete(k);
    this.submitted.delete(k);
    this.operationCheckpoints.delete(k);
    try {
      this.save();
    } catch (e) {
      this.claims.set(k, at);
      if (nonceUsedAt !== undefined) this.submitted.set(k, nonceUsedAt);
      if (checkpoint !== undefined) this.operationCheckpoints.set(k, checkpoint);
      throw e;
    }
  }
  protected save() {}
}

type StoredBlock = { number: string; hash: Hex };
type StoredCheckpoint = { head: StoredBlock; next: StoredBlock | null; earliest: string };

function decodeCheckpoint(stored: StoredCheckpoint | undefined): OperationCheckpoint | undefined {
  const decodeBlock = (block: StoredBlock | null | undefined) =>
    block && typeof block.number === "string" && /^\d{1,78}$/.test(block.number) &&
      typeof block.hash === "string" && /^0x[0-9a-f]{64}$/i.test(block.hash)
      ? { number: BigInt(block.number), hash: block.hash }
      : undefined;
  if (!stored || typeof stored.earliest !== "string" || !/^-?\d{1,78}$/.test(stored.earliest)) return undefined;
  const head = decodeBlock(stored.head);
  const next = stored.next === null ? null : decodeBlock(stored.next);
  if (!head || next === undefined || (next && next.number > head.number)) return undefined;
  return { head, next, earliest: BigInt(stored.earliest) };
}

function encodeCheckpoint(checkpoint: OperationCheckpoint): StoredCheckpoint {
  const block = ({ number, hash }: OperationCheckpoint["head"]): StoredBlock => ({ number: String(number), hash });
  return { head: block(checkpoint.head), next: checkpoint.next && block(checkpoint.next), earliest: String(checkpoint.earliest) };
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
      submitted?: Record<string, number | null>;
      operationCheckpoints?: Record<string, StoredCheckpoint>;
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
    const claims = Array.isArray(data.claims) ? data.claims.map((k) => [k, loadedAt] as const) : Object.entries(data.claims ?? {});
    for (const [k, at] of claims) {
      if (typeof at !== "number" || !Number.isFinite(at)) {
        this.claims.set(k, loadedAt);
        continue;
      }
      if (data.submitted === undefined) {
        // Old stores recorded only claims made just before submission. Extend those that may still land.
        this.claims.set(k, at <= loadedAt ? pinnedAt(at) : Math.min(at, pinnedAt(loadedAt)));
        this.submitted.set(k, null);
        continue;
      }
      this.claims.set(k, Math.min(at, pinnedAt(loadedAt)));
      if (Object.hasOwn(data.submitted, k)) {
        // A failed reset may have left a stale timestamp on disk. Keep the submission, start grace afresh.
        this.submitted.set(k, null);
        const checkpoint = decodeCheckpoint(data.operationCheckpoints?.[k]);
        if (checkpoint) this.operationCheckpoints.set(k, checkpoint);
      }
    }
    this.prune();
  }
  protected override save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      // writeFileSync keeps writing after a short write; a single writeSync call would not.
      writeFileSync(fd, JSON.stringify({
        settled: Object.fromEntries(this.results),
        settledAt: Object.fromEntries(this.settledAt),
        claims: Object.fromEntries(this.claims),
        submitted: Object.fromEntries(this.submitted),
        operationCheckpoints: Object.fromEntries(
          Array.from(this.operationCheckpoints, ([hash, checkpoint]) => [hash, encodeCheckpoint(checkpoint)]),
        ),
      }));
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
