import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RateLimit } from "../src/facilitator/app.js";
import { Catalog } from "../src/facilitator/catalog.js";
import { FileStore, MemoryStore } from "../src/facilitator/store.js";
import { IncentivEoaTxFacilitatorScheme, IncentivUserOpFacilitatorScheme, MAINNET } from "../src/index.js";
import { deadlineMarker } from "../src/eoa.js";
import { opFromWire, transferCall } from "../src/userop.js";

const usdc = MAINNET.usdc;
const merchant = "0x832166144c59Ed3524878441fa67F91615d2133B";

test("opFromWire rejects odd-length hex and quantities that do not fit the EntryPoint's packing", () => {
  const good = {
    sender: merchant, nonce: "0x1", callData: "0x1234", callGasLimit: "0x100", verificationGasLimit: "0x100",
    preVerificationGas: "0x100", maxFeePerGas: "0x100", maxPriorityFeePerGas: "0x1", signature: "0x",
  };
  opFromWire(good);
  assert.throws(() => opFromWire({ ...good, callData: "0x123" }), /even-length/);
  assert.throws(() => opFromWire({ ...good, signature: "0xabc" }), /even-length/);
  assert.throws(() => opFromWire({ ...good, callGasLimit: `0x${"f".repeat(40)}` }), /128 bits/);
  assert.throws(() => opFromWire({ ...good, maxFeePerGas: `0x1${"0".repeat(32)}` }), /128 bits/);
  opFromWire({ ...good, nonce: `0x${"f".repeat(64)}`, preVerificationGas: `0x${"f".repeat(64)}` });
  assert.throws(() => opFromWire({ ...good, nonce: `0x1${"0".repeat(64)}` }), /quantity|256 bits/);
});

test("the rate limiter drops expired windows and refuses a non-numeric limit", () => {
  const rl = new RateLimit(2, 1_000);
  assert.ok(rl.allow("a", 0) && rl.allow("a", 0));
  assert.equal(rl.allow("a", 0), false);
  for (let i = 0; i < 100; i++) rl.allow(`ip${i}`, 10);
  assert.equal(rl.size, 101);
  rl.allow("late", 5_000);
  assert.equal(rl.size, 1);
  assert.throws(() => new RateLimit(Number("abc")), /positive integer/);
});

test("a payment to another address cannot replace a merchant's discovery listing", () => {
  const c = new Catalog();
  const ext = declareDiscoveryExtension({ output: { example: { ok: true } } });
  (ext.bazaar as unknown as { info: { input: Record<string, unknown> } }).info.input.method = "GET";
  const req = (payTo: string) => ({ scheme: "incentiv-eoa-tx", network: "eip155:24101" as const, asset: usdc, amount: "1", payTo, maxTimeoutSeconds: 120, extra: {} });
  const payload = (payTo: string) => ({ x402Version: 2, resource: { url: "https://victim.example/weather" }, accepted: req(payTo), payload: {}, extensions: ext });
  c.record(payload(merchant) as never, req(merchant));
  const attacker = "0x000000000000000000000000000000000000dEaD";
  c.record(payload(attacker) as never, req(attacker));
  const listed = c.list({}).items;
  assert.equal(listed.length, 2);
  assert.ok(listed.some((e) => e.accepts[0]!.payTo === merchant), "the merchant's entry was replaced");
  c.record(payload(merchant) as never, req(merchant));
  assert.equal(c.list({}).items.length, 2, "the same merchant updates its own entry");
});

test("claims: a result clears the claim, release drops it, and the file store keeps both across restarts", () => {
  const m = new MemoryStore();
  m.claim("0xAB");
  assert.ok(m.isClaimed("0xab"));
  m.release("0xab");
  assert.equal(m.isClaimed("0xab"), false);
  m.claim("0xcd");
  m.set("0xcd", { success: true, transaction: "0x1", network: "eip155:24101" });
  assert.equal(m.isClaimed("0xcd"), false);
  assert.equal(m.get("0xCD")?.success, true);

  const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
  const f = new FileStore(join(dir, "s.json"));
  f.claim("0x01");
  f.set("0x02", { success: true, transaction: "0x2", network: "eip155:24101" });
  const again = new FileStore(join(dir, "s.json"));
  assert.ok(again.isClaimed("0x01"));
  assert.equal(again.get("0x02")?.transaction, "0x2");
  // The earlier on-disk format, a bare map of results, still loads.
  writeFileSync(join(dir, "old.json"), JSON.stringify({ "0x03": { success: true, transaction: "0x3", network: "eip155:24101" } }));
  assert.equal(new FileStore(join(dir, "old.json")).get("0x03")?.transaction, "0x3");
  assert.ok(readFileSync(join(dir, "s.json"), "utf8").includes("claims"));
});

test("requirements without a numeric maxTimeoutSeconds are refused before any deadline arithmetic", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const raw = await owner.signTransaction({
    type: "eip1559", chainId: MAINNET.chainId, to: usdc, value: 0n, data: transferCall(usdc, merchant, 10_000n).data, nonce: 0, gas: 60_000n,
    maxFeePerGas: 48_000_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    accessList: [{ address: deadlineMarker(Math.floor(Date.now() / 1000) + 10 * 365 * 86_400), storageKeys: [] }],
  });
  for (const maxTimeoutSeconds of [undefined, "120", 0, 1.5]) {
    const eoaReq = { scheme: "incentiv-eoa-tx", network: "eip155:24101", asset: usdc, amount: "10000", payTo: merchant, maxTimeoutSeconds, extra: {} };
    const v = await new IncentivEoaTxFacilitatorScheme().verify({ x402Version: 2, accepted: eoaReq, payload: { signedTransaction: raw } } as never, eoaReq as never);
    assert.equal(v.invalidReason, "invalid_payment_requirements", `eoa, maxTimeoutSeconds=${maxTimeoutSeconds}`);
    const opReq = { ...eoaReq, scheme: "incentiv-userop", extra: { entryPoint: MAINNET.entryPoint } };
    const u = await new IncentivUserOpFacilitatorScheme().verify({ x402Version: 2, accepted: opReq, payload: {} } as never, opReq as never);
    assert.equal(u.invalidReason, "invalid_payment_requirements", `userop, maxTimeoutSeconds=${maxTimeoutSeconds}`);
  }
});
