import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import { MAINNET } from "../src/constants.js";
import { OperationHistory } from "../src/facilitator/operation-history.js";
import { FileStore } from "../src/facilitator/store.js";
import type { Chain } from "../src/userop.js";

const sender = "0x832166144c59Ed3524878441fa67F91615d2133B";
const operationHash: Hex = `0x${"aa".repeat(32)}`;
const receiptHash: Hex = `0x${"bb".repeat(32)}`;
const blockHash = (number: bigint): Hex => `0x${number.toString(16).padStart(64, "0")}`;

function historyChain(head: bigint) {
  const state = {
    head, fork: 0n, nonce: 1n, unavailable: undefined as bigint | undefined,
    staleBlock: undefined as bigint | undefined,
    rangeHint: undefined as bigint | undefined,
    included: undefined as bigint | undefined,
    onRead: (_block: bigint): void | Promise<void> => {},
    onHeader: () => {},
    bloom: (_block: bigint): Hex | undefined => undefined,
    exactReads: [] as bigint[],
  };
  const chain = {
    config: MAINNET,
    client: {
      getBlock: async ({ blockNumber = state.head }: { blockNumber?: bigint }) => {
        state.onHeader();
        const fork = blockNumber === state.staleBlock ? 0n : state.fork;
        return {
          number: blockNumber, timestamp: blockNumber, hash: blockHash(blockNumber + fork),
          parentHash: blockHash((blockNumber > 0n ? blockNumber - 1n : 0n) + fork),
          logsBloom: state.bloom(blockNumber),
        };
      },
      readContract: async ({ blockHash: at, requireCanonical }: { blockHash: Hex; requireCanonical: boolean }) => {
        assert.equal(at, blockHash(state.head + state.fork));
        assert.equal(requireCanonical, true);
        return state.nonce;
      },
      getLogs: async ({ blockHash: at }: { blockHash?: Hex }) => {
        const hint = state.rangeHint;
        if (!at && hint === undefined) return [];
        if (hint !== undefined && (!at || at === blockHash(hint))) {
          return [{
            transactionHash: receiptHash, blockNumber: hint, blockHash: blockHash(hint), removed: false,
            args: { userOpHash: operationHash, sender, nonce: 0n, success: true },
          }];
        }
        const block = BigInt(at!) - state.fork;
        state.exactReads.push(block);
        await state.onRead(block);
        if (block === state.unavailable) throw new Error("unknown block");
        if (block !== state.included) return [];
        return [{
          transactionHash: receiptHash, blockNumber: block, blockHash: at, removed: false,
          args: { userOpHash: operationHash, sender, nonce: 0n, success: true },
        }];
      },
    },
  } as unknown as Chain;
  const history = new OperationHistory();
  const find = (canContinue = () => true, search = history) => search.find(chain, operationHash, sender, 0n, 0, canContinue);
  return { state, find };
}

test("a stale replica cannot supply a receipt outside the nonce snapshot ancestry", async () => {
  const { state, find } = historyChain(5n);
  state.fork = 1_000n;
  state.staleBlock = state.rangeHint = 3n;
  assert.equal(await find(), undefined);
  state.staleBlock = undefined;
  assert.deepEqual(await find(), { absentAt: { number: 5n, hash: blockHash(1_005n) } });
});

test("a checkpoint on another fork cannot establish absence for a new snapshot", async () => {
  const { state, find } = historyChain(3n);
  assert.deepEqual(await find(), { absentAt: { number: 3n, hash: blockHash(3n) } });
  state.head = 5n;
  state.fork = 1_000n;
  state.staleBlock = 3n;
  state.included = 2n;
  assert.equal(await find(), undefined);
  state.staleBlock = undefined;
  const result = await find();
  assert.ok(result && result !== "nonce_unused" && "transactionHash" in result);
  assert.equal(result.transactionHash, receiptHash);
});

test("a descendant snapshot reuses the proven checkpoint", async () => {
  const { state, find } = historyChain(3n);
  await find();
  state.exactReads.length = 0;
  state.head = 4n;
  assert.deepEqual(await find(), { absentAt: { number: 4n, hash: blockHash(4n) } });
  assert.deepEqual(state.exactReads, [4n]);
});

test("a search head whose nonce is unused cannot establish absence", async () => {
  const { state, find } = historyChain(12n);
  state.nonce = 0n;
  assert.equal(await find(), "nonce_unused");
  assert.deepEqual(state.exactReads, []);
});

test("an unavailable block keeps the proof retryable", async () => {
  const { state, find } = historyChain(3n);
  state.included = state.unavailable = 1n;
  assert.equal(await find(), undefined);
  state.unavailable = undefined;
  state.exactReads.length = 0;
  const result = await find();
  assert.ok(result && result !== "nonce_unused" && "transactionHash" in result);
  assert.equal(result.transactionHash, receiptHash);
  assert.ok(state.exactReads.includes(1n));
});

test("a history retry resumes proven blocks and revisits them after a reorg", async () => {
  const { state, find } = historyChain(511n);
  let withinBudget = true;
  state.onRead = (block) => { if (block === 255n) withinBudget = false; };
  assert.equal(await find(() => withinBudget), undefined);

  state.exactReads.length = 0;
  state.onRead = () => {};
  assert.deepEqual(await find(), { absentAt: { number: 511n, hash: blockHash(511n) } });
  assert.equal(state.exactReads[0], 255n);
  assert.equal(state.exactReads.length, 256);

  state.exactReads.length = 0;
  state.fork = 1_000n;
  state.included = 510n;
  const result = await find();
  assert.ok(result && result !== "nonce_unused" && "transactionHash" in result);
  assert.equal(result.transactionHash, receiptHash);
  assert.equal(state.exactReads[0], 511n);
});

test("an old claim resumes a verified history batch after reopening the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-history-"));
  try {
    const path = join(dir, "settled.json");
    const first = new FileStore(path);
    first.claimForSubmission(operationHash);
    const head = 114_999n;
    const { state, find } = historyChain(head);
    let withinBudget = true;
    state.onRead = (block) => { if (block === head - 256n) withinBudget = false; };
    assert.equal(await find(() => withinBudget, new OperationHistory(first)), undefined);

    const reopened = new FileStore(path);
    assert.equal(reopened.getOperationCheckpoint(operationHash)?.next?.number, head - 256n);
    state.exactReads.length = 0;
    state.onRead = () => {};
    state.included = head - 300n;
    const result = await find(() => true, new OperationHistory(reopened));
    assert.ok(result && result !== "nonce_unused" && "transactionHash" in result);
    assert.equal(result.transactionHash, receiptHash);
    assert.equal(state.exactReads[0], head - 256n);

    reopened.release(operationHash);
    assert.equal(new FileStore(path).getOperationCheckpoint(operationHash), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("old history can prove absence across bounded settlement windows and restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-history-budget-"));
  try {
    const path = join(dir, "settled.json");
    new FileStore(path).claimForSubmission(operationHash);
    const head = 114_999n;
    const { state, find } = historyChain(head);
    const empty: Hex = `0x${"0".repeat(512)}`;
    state.bloom = () => empty;
    let rounds = 0;
    let requests = 0;
    let elapsed = 0;
    let batch = false;
    state.onHeader = () => {
      if (batch) return;
      batch = true;
      queueMicrotask(() => { batch = false; });
      requests++;
      elapsed += 150; // Model latency for parallel header reads and individual snapshot checks.
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      rounds++;
      elapsed = 0;
      const result = await find(() => elapsed < 60_000, new OperationHistory(new FileStore(path)));
      if (result !== undefined) {
        assert.deepEqual(result, { absentAt: { number: head, hash: blockHash(head) } });
        assert.equal(rounds, 2);
        assert.ok(requests < 550, `unexpected number of RPC rounds: ${requests}`);
        assert.deepEqual(state.exactReads, []);
        return;
      }
    }
    assert.fail("history did not complete within the modeled retry budget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid history cursor restarts the proof on a subsequent retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-history-cursor-"));
  try {
    const path = join(dir, "settled.json");
    const store = new FileStore(path);
    const head = { number: 127n, hash: blockHash(127n) };
    store.claimForSubmission(operationHash);
    store.saveOperationCheckpoint(operationHash, {
      head, next: { number: 63n, hash: blockHash(900n) }, earliest: 0n,
    });
    const { state, find } = historyChain(head.number);
    state.included = 120n;
    assert.equal(await find(() => true, new OperationHistory(store)), undefined);

    const reopened = new FileStore(path);
    assert.deepEqual(reopened.getOperationCheckpoint(operationHash)?.next, head);
    const result = await find(() => true, new OperationHistory(reopened));
    assert.ok(result && result !== "nonce_unused" && "transactionHash" in result);
    assert.equal(result.transactionHash, receiptHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a retry waits for an expired history scan to release its RPC batch", async () => {
  const { state, find } = historyChain(3n);
  let withinBudget = true;
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  state.onRead = (block) => {
    if (block === 3n) {
      start();
      return waiting;
    }
  };

  const first = find(() => withinBudget);
  await started;
  withinBudget = false;
  assert.equal(await find(), undefined);
  assert.deepEqual(state.exactReads, [3n, 2n, 1n, 0n]);
  release();
  assert.equal(await first, undefined);

  state.onRead = () => {};
  assert.deepEqual(await find(), { absentAt: { number: 3n, hash: blockHash(3n) } });
});

test("a bloom skips unrelated logs and still queries a matching exact block", async () => {
  const { state, find } = historyChain(3n);
  state.included = 2n;
  state.bloom = (block) => {
    const bloom = new Uint8Array(256);
    const topics = block === state.included ? [MAINNET.entryPoint, operationHash] : [MAINNET.entryPoint, receiptHash];
    for (const topic of topics) {
      const digest = hexToBytes(keccak256(topic));
      for (const offset of [0, 2, 4]) {
        const bit = ((digest[offset]! << 8) | digest[offset + 1]!) & 2047;
        const index = 255 - (bit >> 3);
        bloom[index] = bloom[index]! | (1 << (bit & 7));
      }
    }
    return bytesToHex(bloom);
  };
  const result = await find();
  assert.ok(result && result !== "nonce_unused" && "transactionHash" in result);
  assert.equal(result.transactionHash, receiptHash);
  assert.deepEqual(state.exactReads, [2n]);
});

test("a reorg during a log lookup leaves that page uncheckpointed", async () => {
  const { state, find } = historyChain(3n);
  state.onRead = (block) => { if (block === 3n) state.fork = 1_000n; };
  assert.equal(await find(), undefined);

  state.onRead = () => {};
  state.exactReads.length = 0;
  state.included = 3n;
  const result = await find();
  assert.ok(result && result !== "nonce_unused" && "transactionHash" in result);
  assert.equal(result.transactionHash, receiptHash);
  assert.equal(state.exactReads[0], 3n);
});
