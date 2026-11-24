import type { SettleResponse } from "@x402/core/types";
import { logMessage } from "../decode.js";
import type { SettledStore } from "./store.js";

export function nonceUsedPastGrace(
  store: SettledStore, hash: string, now: () => number, used: boolean | undefined,
  log: (line: Record<string, unknown>) => void,
): boolean {
  if (used === undefined || !store.isSubmitted(hash)) return false;
  try {
    return store.nonceUsedPastGrace(hash, used, now());
  } catch (e) {
    log({ event: "store_error", hash, error: logMessage(e) });
    return false;
  }
}

export function recordNonceUsed(
  store: SettledStore, hash: string, result: SettleResponse, retryable: SettleResponse,
  log: (line: Record<string, unknown>) => void,
): SettleResponse {
  try {
    store.set(hash, result);
    return result;
  } catch (e) {
    log({ event: "store_error", hash, error: logMessage(e) });
    return retryable;
  }
}
