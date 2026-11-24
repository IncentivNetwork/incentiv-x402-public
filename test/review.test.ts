import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import express from "express";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RateLimit } from "../src/facilitator/app.js";
import { Catalog } from "../src/facilitator/catalog.js";
import { FileStore, MemoryStore, NONCE_USED_GRACE_MS, RESULT_TTL_MS, type SettledStore } from "../src/facilitator/store.js";
import { EOA_SCHEME, IncentivEoaTxFacilitatorScheme, IncentivEoaTxScheme, IncentivUserOpFacilitatorScheme, IncentivUserOpScheme, MAINNET, NETWORK, SCHEME } from "../src/index.js";
import { deadlineMarker } from "../src/eoa.js";
import { opFromWire, transferCall } from "../src/userop.js";

const usdc = MAINNET.usdc;
const merchant = "0x832166144c59Ed3524878441fa67F91615d2133B";

test("upfront settlement keeps pending payments out of Express handlers", async () => {
  const handled: string[] = [];
  let settled = false;
  const resource = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [EOA_SCHEME, SCHEME].map((scheme) => ({ x402Version: 2, scheme, network: NETWORK })),
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: true }),
    settle: async () => settled
      ? { success: true, transaction: `0x${"11".repeat(32)}`, network: NETWORK }
      : { success: false, errorReason: "settle_timeout", transaction: "", network: NETWORK },
  });
  resource.register(NETWORK, new IncentivEoaTxScheme());
  resource.register(NETWORK, new IncentivUserOpScheme());

  const app = express();
  const accepts = (scheme: string) => ({
    scheme, network: NETWORK, payTo: merchant, price: "$0.01", extra: { paymentFlow: "upfront" },
  });
  app.use(paymentMiddleware({
    "GET /eoa": { accepts: accepts(EOA_SCHEME) },
    "GET /userop": { accepts: accepts(SCHEME) },
  }, resource));
  app.get(["/eoa", "/userop"], (req, res) => {
    handled.push(req.path);
    res.json({ paid: true });
  });
  const listener = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", resolve);
      listener.once("error", reject);
    });
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    for (const route of ["/eoa", "/userop"]) {
      const url = base + route;
      const prompt = await fetch(url);
      assert.equal(prompt.status, 402);
      const { accepts: [accepted] } = decodePaymentRequiredHeader(prompt.headers.get("payment-required")!);
      assert.ok(accepted);
      assert.equal(accepted.extra.paymentFlow, "upfront");
      await prompt.text();
      const headers = { "payment-signature": encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: {} }) };
      settled = false;
      const pending = await fetch(url, { headers });
      assert.equal(pending.status, 402);
      await pending.text();
      assert.ok(!handled.includes(route));
      settled = true;
      const paid = await fetch(url, { headers });
      assert.equal(paid.status, 200);
      assert.deepEqual(await paid.json(), { paid: true });
      assert.equal(handled.filter((path) => path === route).length, 1);
    }
  } finally {
    listener.close();
  }
});

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

test("legacy claims migrate to the submission lifetime, and the earlier list format still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-claims-"));
  const path = join(dir, "s.json");
  writeFileSync(path, JSON.stringify({ settled: {}, claims: {
    "0xold": Date.now() - RESULT_TTL_MS - 60_000,
    "0xlate": Date.now() - 2 * 3_600_000,
    "0xnew": Date.now() - 60_000,
  } }));
  const s = new FileStore(path);
  assert.equal(s.isClaimed("0xold"), false, "a stale claim is dropped on load");
  assert.ok(s.isSubmitted("0xlate"), "the legacy claim can recover a late receipt");
  assert.ok(s.isClaimed("0xnew"));
  writeFileSync(path, JSON.stringify({ settled: {}, claims: ["0xlisted"] }));
  assert.ok(new FileStore(path).isClaimed("0xlisted"), "a claim from the list format counts as claimed now");
});

test("a resubmission keeps the original claim lifetime", () => {
  const store = new MemoryStore();
  const now = Date.now;
  const submittedAt = now();
  try {
    Date.now = () => submittedAt;
    store.claimForSubmission("0xaa");
    Date.now = () => submittedAt + RESULT_TTL_MS - 1;
    store.claimForSubmission("0xaa");
    assert.ok(store.isClaimed("0xaa"));
    Date.now = () => submittedAt + RESULT_TTL_MS;
    assert.equal(store.isClaimed("0xaa"), false);
  } finally {
    Date.now = now;
  }
});

test("a failed nonce reset starts fresh grace after reopening the file store", () => {
  class FailingFileStore extends FileStore {
    fail = false;
    protected override save() {
      if (this.fail) throw new Error("write failed");
      super.save();
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "x402-observed-nonce-"));
  try {
    const path = join(dir, "s.json");
    const hash = "0xaa";
    const now = Date.now();
    const store = new FailingFileStore(path);
    store.claimForSubmission(hash);
    store.nonceUsedPastGrace(hash, true, now - NONCE_USED_GRACE_MS);
    store.fail = true;
    assert.throws(() => store.nonceUsedPastGrace(hash, false, now), /write failed/);
    const stored = JSON.parse(readFileSync(path, "utf8")) as { submitted: Record<string, number> };
    assert.equal(stored.submitted[hash], now - NONCE_USED_GRACE_MS);

    const reopened = new FileStore(path);
    const nextObservation = now + 1;
    assert.ok(reopened.isSubmitted(hash));
    assert.equal(reopened.nonceUsedPastGrace(hash, true, nextObservation), false);
    assert.equal(reopened.nonceUsedPastGrace(hash, true, nextObservation + NONCE_USED_GRACE_MS - 1), false);
    assert.equal(reopened.nonceUsedPastGrace(hash, true, nextObservation + NONCE_USED_GRACE_MS), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed nonce reset cannot restore an expired grace observation", () => {
  class FailingStore extends MemoryStore {
    fail = false;
    protected override save() {
      if (this.fail) throw new Error("write failed");
    }
  }
  const store = new FailingStore();
  const hash = "0xaa";
  const now = Date.now();
  store.claimForSubmission(hash);
  store.nonceUsedPastGrace(hash, true, now - NONCE_USED_GRACE_MS);
  store.fail = true;
  assert.throws(() => store.nonceUsedPastGrace(hash, false, now), /write failed/);
  assert.throws(() => store.nonceUsedPastGrace(hash, true, now + 1), /write failed/);
  store.fail = false;
  assert.equal(store.nonceUsedPastGrace(hash, true, now + 1), false);
  assert.equal(store.nonceUsedPastGrace(hash, true, now + NONCE_USED_GRACE_MS), false);
  assert.equal(store.nonceUsedPastGrace(hash, true, now + 1 + NONCE_USED_GRACE_MS), true);
});

test("custom stores declare their submission recovery capabilities", () => {
  const store = new MemoryStore();
  const legacy = {
    get: store.get.bind(store), set: store.set.bind(store), claim: store.claim.bind(store),
    isClaimed: store.isClaimed.bind(store), release: store.release.bind(store),
  };
  assert.throws(() => new IncentivEoaTxFacilitatorScheme({ store: legacy as SettledStore }), /submission claims/);
  assert.throws(() => new IncentivUserOpFacilitatorScheme({ store: legacy as SettledStore }), /submission claims/);
  const custom: SettledStore = {
    ...legacy,
    claimForSubmission: store.claimForSubmission.bind(store),
    isSubmitted: store.isSubmitted.bind(store),
    nonceUsedPastGrace: store.nonceUsedPastGrace.bind(store),
  };
  assert.doesNotThrow(() => new IncentivEoaTxFacilitatorScheme({ store: custom }));
  assert.doesNotThrow(() => new IncentivUserOpFacilitatorScheme({ store: custom }));
});

test("a catalog file saved before the key held network and payTo loses those entries and keeps the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-catalog-"));
  const path = join(dir, "catalog.json");
  const accepts = [{ scheme: "incentiv-eoa-tx", network: "eip155:24101", asset: usdc, amount: "10000", payTo: merchant, maxTimeoutSeconds: 120, extra: {} }];
  const entry = { resource: "https://api.example.com/weather", type: "http", x402Version: 2, accepts, lastUpdated: "2026-11-19T00:00:00.000Z" };
  writeFileSync(path, JSON.stringify({
    "GET https://api.example.com/weather": entry,
    [`GET https://api.example.com/other eip155:24101 ${merchant.toLowerCase()}`]: { ...entry, resource: "https://api.example.com/other" },
  }));
  const c = new Catalog(path, () => Date.parse("2026-11-19T01:00:00Z"));
  assert.deepEqual(c.list({}).items.map((e) => e.resource), ["https://api.example.com/other"]);
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 1, "the cleaned file is saved");
});
