import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SettleResponse } from "@x402/core/types";

/** Remembers settled operations by user operation hash so a retry never pays twice. */
export interface SettledStore {
  get(userOpHash: string): SettleResponse | undefined;
  set(userOpHash: string, result: SettleResponse): void;
}

export class MemoryStore implements SettledStore {
  protected readonly map = new Map<string, SettleResponse>();
  get(hash: string) {
    return this.map.get(hash.toLowerCase());
  }
  set(hash: string, result: SettleResponse) {
    this.map.set(hash.toLowerCase(), result);
  }
}

/** A JSON file, rewritten atomically on each settlement. Enough for one facilitator process. */
export class FileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, SettleResponse>)) this.map.set(k, v);
    }
  }
  override set(hash: string, result: SettleResponse) {
    super.set(hash, result);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
    renameSync(tmp, this.path);
  }
}
