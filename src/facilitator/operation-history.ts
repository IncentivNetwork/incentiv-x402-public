import { hexToBytes, isAddressEqual, keccak256, parseAbiItem, type Address, type Hex } from "viem";
import { entryPointAbi } from "../abi.js";
import { logMessage } from "../decode.js";
import type { Chain, OpReceipt } from "../userop.js";
import type { SettledStore } from "./store.js";

const operationEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const PROOF_BATCH = 256;
const SAVE_EVERY_BATCHES = 8;
const MAX_CHECKPOINTS = 256;

type BlockRef = { number: bigint; hash: Hex };
export type OperationCheckpoint = { head: BlockRef; next: BlockRef | null; earliest: bigint };
type CheckpointStore = Pick<SettledStore, "getOperationCheckpoint" | "saveOperationCheckpoint">;
type SearchResult = OpReceipt | { absentAt: BlockRef } | "nonce_unused" | undefined;

function bloomMask(value: Hex): bigint {
  const digest = hexToBytes(keccak256(value));
  let mask = 0n;
  for (const offset of [0, 2, 4]) {
    mask |= 1n << BigInt(((digest[offset]! << 8) | digest[offset + 1]!) & 2047);
  }
  return mask;
}

export class OperationHistory {
  private readonly checkpoints = new Map<Hex, OperationCheckpoint>();
  private readonly active = new Set<Hex>();

  constructor(
    private readonly store?: CheckpointStore,
    private readonly log: (line: Record<string, unknown>) => void = () => {},
  ) {}

  /** Return the snapshot that establishes absence, a conflicting nonce observation, or a located receipt. */
  async find(
    chain: Chain, hash: Hex, sender: Address, nonce: bigint, earliestTimestamp: number, canContinue: () => boolean,
  ): Promise<SearchResult> {
    if (!canContinue() || this.active.has(hash)) return undefined;
    this.active.add(hash);
    try {
      return await this.search(chain, hash, sender, nonce, earliestTimestamp, canContinue);
    } finally {
      this.active.delete(hash);
    }
  }

  private async search(
    chain: Chain, hash: Hex, sender: Address, nonce: bigint, earliestTimestamp: number, canContinue: () => boolean,
  ): Promise<SearchResult> {
    const client = chain.client;
    const latest = await client.getBlock({ blockTag: "latest" });
    const earliest = BigInt(earliestTimestamp);
    if (!latest.hash || latest.timestamp < earliest || !canContinue()) return undefined;
    const current = await client.readContract({
      address: chain.config.entryPoint, abi: entryPointAbi, functionName: "getNonce",
      args: [sender, nonce >> 64n], blockHash: latest.hash, requireCanonical: true,
    });
    if (!canContinue()) return undefined;
    if (current <= nonce) return "nonce_unused";

    const head = { number: latest.number, hash: latest.hash };
    const canonical = async (block: BlockRef) =>
      canContinue() && (await client.getBlock({ blockNumber: block.number })).hash === block.hash && canContinue();
    const filter = { address: chain.config.entryPoint, event: operationEvent, args: { userOpHash: hash }, strict: true } as const;
    const exactLogs = (blockHash: Hex) => client.getLogs({ ...filter, blockHash });
    const readOutcome = (logs: Awaited<ReturnType<typeof exactLogs>>, block: BlockRef): OpReceipt | null | undefined => {
      if (logs.length === 0) return null;
      const log = logs[0];
      if (!log || logs.length !== 1 || log.removed || !log.transactionHash ||
          log.blockNumber !== block.number || log.blockHash !== block.hash ||
          log.args.userOpHash.toLowerCase() !== hash.toLowerCase() ||
          !isAddressEqual(log.args.sender, sender) || log.args.nonce !== nonce) return undefined;
      return { userOpHash: hash, transactionHash: log.transactionHash, blockNumber: String(block.number), success: log.args.success };
    };

    let previous = this.checkpoints.get(hash) ?? this.store?.getOperationCheckpoint?.(hash);
    if (previous?.earliest !== earliest) previous = undefined;
    if (previous && previous.head.number > head.number) return undefined;

    let next: BlockRef | null = head;
    if (previous?.head.hash === head.hash && previous.head.number === head.number) {
      next = previous.next;
      previous = undefined;
    }
    const mask = bloomMask(chain.config.entryPoint) | bloomMask(hash);
    let batches = 0;
    while (next && canContinue()) {
      const top = next;
      const size = top.number < BigInt(PROOF_BATCH) ? Number(top.number + 1n) : PROOF_BATCH;
      const headers = await Promise.all(Array.from({ length: size }, (_, offset) =>
        client.getBlock({ blockNumber: top.number - BigInt(offset) }).catch(() => undefined),
      ));
      if (!canContinue()) return undefined;
      // Walk backwards from the nonce-bearing snapshot and verify that the requested blocks join its ancestry.
      const eligible: { block: BlockRef; empty: boolean }[] = [];
      for (const block of headers) {
        if (!block) return undefined;
        if (!next || block.number !== next.number || block.hash !== next.hash) {
          if (canContinue()) {
            const restart = { head, next: head, earliest };
            this.rememberCheckpoint(hash, restart);
            this.persistCheckpoint(hash, restart);
          }
          return undefined;
        }
        // The parent links above must lead to the saved snapshot before its proof can be reused.
        if (previous && next.number === previous.head.number) {
          const saved = previous;
          previous = undefined;
          if (next.hash === saved.head.hash) {
            next = saved.next;
            break;
          }
        }
        if (block.timestamp < earliest) {
          next = null;
          break;
        }
        const bloom = block.logsBloom;
        const excludesOperation = bloom && /^0x[0-9a-f]{512}$/i.test(bloom) && (BigInt(bloom) & mask) !== mask;
        eligible.push({ block: next, empty: Boolean(excludesOperation) });
        next = block.number === 0n ? null : { number: block.number - 1n, hash: block.parentHash };
      }
      if (!canContinue()) return undefined;
      const results = await Promise.all(eligible.map(({ block, empty }) =>
        empty ? null : exactLogs(block.hash).then((logs) => readOutcome(logs, block)).catch(() => undefined),
      ));
      if (!canContinue()) return undefined;
      const located = results.find((result) => result);
      if (located) {
        if (!(await canonical(head))) return undefined;
        this.checkpoints.delete(hash);
        return located;
      }
      if (results.includes(undefined)) return undefined;
      const progress = { head, next, earliest };
      batches++;
      const save = batches === 1 || batches % SAVE_EVERY_BATCHES === 0 || next === null;
      if (save && !(await canonical(head))) return undefined;
      this.rememberCheckpoint(hash, progress);
      if (save) this.persistCheckpoint(hash, progress);
      if (next === null) return canContinue() ? { absentAt: head } : undefined;
    }
    return next === null && await canonical(head) ? { absentAt: head } : undefined;
  }

  private persistCheckpoint(hash: Hex, checkpoint: OperationCheckpoint) {
    try {
      this.store?.saveOperationCheckpoint?.(hash, checkpoint);
    } catch (e) {
      this.log({ event: "store_error", hash, error: logMessage(e) });
    }
  }

  private rememberCheckpoint(hash: Hex, checkpoint: OperationCheckpoint) {
    this.checkpoints.delete(hash);
    this.checkpoints.set(hash, checkpoint);
    if (this.checkpoints.size > MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next();
      if (!oldest.done) this.checkpoints.delete(oldest.value);
    }
  }
}
