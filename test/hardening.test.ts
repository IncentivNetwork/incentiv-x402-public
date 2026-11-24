import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import * as viem from "viem";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { spawn } from "node:child_process";
import express from "express";
import { createFacilitatorApp, rateKey } from "../src/facilitator/app.js";
import { Catalog, CATALOG_LIMITS, QueryTooLongError } from "../src/facilitator/catalog.js";
import { CLAIM_TTL_MS, FileStore, MemoryStore, NONCE_USED_GRACE_MS, RESULT_TTL_MS } from "../src/facilitator/store.js";
import { checkPaysRequirements, logMessage, PaymentError, publicMessage } from "../src/decode.js";
import { IncentivEoaTxFacilitatorScheme, IncentivUserOpFacilitatorScheme, MAINNET } from "../src/index.js";
import { BundlerRpcError, bundlerRpc, nonceRefusal } from "../src/userop.js";
import { encodeAbiParameters, encodeEventTopics, HttpRequestError, RpcRequestError, zeroAddress, type Address, type Hex } from "viem";
import { entryPointAbi, erc20Abi } from "../src/abi.js";

const merchant = "0x832166144c59Ed3524878441fa67F91615d2133B";
const req = (payTo = merchant) => ({ scheme: "incentiv-eoa-tx", network: "eip155:24101" as const, asset: MAINNET.usdc, amount: "1", payTo, maxTimeoutSeconds: 120, extra: {} });
const payment: { token: Address; to: Address; amount: bigint } = { token: MAINNET.usdc, to: "0x0000000000000000000000000000000000000001", amount: 1n };
const transferLog = ({ token, to, amount } = payment, from: Address = merchant) => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
});
const paidReceipt = { status: "success", logs: [transferLog()] };
const bazaar = () => {
  const ext = declareDiscoveryExtension({ output: { example: { ok: true } } });
  (ext.bazaar as unknown as { info: { input: Record<string, unknown> } }).info.input.method = "GET";
  return ext.bazaar as unknown as Record<string, unknown> & { info: Record<string, unknown> };
};
const payload = (url: string, ext: unknown = bazaar(), payTo = merchant) => ({
  x402Version: 2,
  resource: { url, description: "Weather" },
  accepted: req(payTo),
  payload: {},
  extensions: { bazaar: ext },
});
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
/** A port that was free a moment ago: the OS picks it, and it is released for the caller to use. */
const freePort = async () => {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  const { port } = probe.address() as AddressInfo;
  await new Promise((ok) => probe.close(ok));
  return port;
};

test("a payer-supplied JSON schema is never compiled here, and one with regular expressions is not served", () => {
  const c = new Catalog();
  const ext = bazaar();
  // 27 characters: compiling and running the pattern takes seconds, so a regression fails here instead of hanging.
  ext.info.x = "a".repeat(27) + "!";
  ext.schema = { type: "object", properties: { x: { type: "string", pattern: "^(a+)+$" } } };
  const started = Date.now();
  const r = c.record(payload("https://api.example.com/weather", ext) as never, req());
  assert.ok(Date.now() - started < 500, `record took ${Date.now() - started} ms`);
  assert.equal(r.rejectedReason, "the discovery schema may not use regular expressions");
  const pp = bazaar();
  pp.schema = { type: "object", patternProperties: { "^x": { type: "string" } } };
  assert.equal(c.record(payload("https://api.example.com/pp", pp) as never, req()).status, "rejected");
  // A property that happens to be named "pattern" is fine.
  const named = bazaar();
  named.schema = { type: "object", properties: { pattern: { type: "string" } } };
  assert.equal(c.record(payload("https://api.example.com/named", named) as never, req()).status, "success");
});

test("the catalog refuses oversized, malformed and non-http discovery info", () => {
  const c = new Catalog();
  const big = bazaar();
  big.info.padding = "x".repeat(CATALOG_LIMITS.maxExtensionChars);
  assert.match(c.record(payload("https://api.example.com/a", big) as never, req()).rejectedReason ?? "", /characters/);
  assert.equal(c.record(payload("https://api.example.com/b", { info: { input: { type: "http", method: "TRACE" } } }) as never, req()).status, "rejected");
  assert.equal(c.record(payload("https://api.example.com/c", { info: {} }) as never, req()).status, "rejected");
  assert.equal(c.record(payload("ftp://api.example.com/d") as never, req()).status, "rejected");
  assert.equal(c.list({}).pagination.total, 0);
});

test("junk listings sent to a merchant's payTo do not block its new routes, and cannot push out established ones", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const c = new Catalog(undefined, () => t0 + 10_000);
  const urls = () => c.list({ payTo: merchant, limit: 100 }).items.map((e) => e.resource);
  // The merchant's real route, paid by three customers.
  for (let i = 0; i < 3; i++) c.record(payload("https://api.merchant.example/v1") as never, req(), new Date(t0 + i), addr(100 + i));
  // One attacker address pays the merchant 1 unit, over and over, with junk URLs.
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo + 20; i++) {
    c.record(payload(`https://junk.example/${i}`) as never, req(), new Date(t0 + 1000 + i), addr(1));
  }
  assert.equal(urls().length, CATALOG_LIMITS.maxEntriesPerPayTo);
  assert.ok(urls().includes("https://api.merchant.example/v1"), "the established listing survives the junk");
  // A new real route's first customer ties with the junk, and a tie keeps the incumbent; that payer is remembered,
  // so the second customer gets the route in.
  assert.equal(c.record(payload("https://api.merchant.example/v2") as never, req(), new Date(t0 + 5000), addr(200)).rejectedReason, "no room for this payTo");
  assert.equal(c.record(payload("https://api.merchant.example/v2") as never, req(), new Date(t0 + 5001), addr(201)).status, "success");
  assert.ok(urls().includes("https://api.merchant.example/v2"));
});

test("one junk payment cannot evict a listing with a single repeat customer", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const c = new Catalog(undefined, () => t0 + 10_000);
  for (let r = 0; r < CATALOG_LIMITS.maxEntriesPerPayTo; r++) {
    for (let i = 0; i < 100; i++) c.record(payload(`https://api.merchant.example/r${r}`) as never, req(), new Date(t0 + i), addr(1000 + r));
  }
  for (let j = 0; j < CATALOG_LIMITS.maxEntriesPerPayTo; j++) {
    assert.equal(c.record(payload(`https://junk.example/${j}`) as never, req(), new Date(t0 + 1000 + j), addr(1)).status, "rejected");
  }
  // Repeat payments by one junk payer stop counting at maxPaymentsPerPayer, which only ties.
  for (let i = 0; i < 10; i++) c.record(payload("https://junk.example/0") as never, req(), new Date(t0 + 2000 + i), addr(1));
  assert.equal(c.list({ payTo: merchant, limit: 100 }).items.filter((e) => e.resource.includes("junk")).length, 0);
});

test("a payTo filled with junk admits the merchant's new route once it has more customers than the junk has payments", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const c = new Catalog(undefined, () => t0 + 10_000);
  // 50 junk routes, each paid by two attacker addresses.
  for (let j = 0; j < CATALOG_LIMITS.maxEntriesPerPayTo; j++) {
    for (const p of [1, 2]) c.record(payload(`https://junk.example/${j}`) as never, req(), new Date(t0 + j), addr(p));
  }
  const results = [0, 1, 2].map((i) => c.record(payload("https://api.merchant.example/new") as never, req(), new Date(t0 + 1000 + i), addr(300 + i)).status);
  assert.deepEqual(results, ["rejected", "rejected", "success"]);
  // The refused payers are forgotten after staleMs without a payment.
  const d = new Catalog(undefined, () => t0);
  for (let j = 0; j < CATALOG_LIMITS.maxEntriesPerPayTo; j++) {
    for (const p of [1, 2]) d.record(payload(`https://junk.example/${j}`) as never, req(), new Date(t0 + j), addr(p));
  }
  d.record(payload("https://api.merchant.example/new") as never, req(), new Date(t0 + 1000), addr(300));
  d.record(payload("https://api.merchant.example/new") as never, req(), new Date(t0 + 1001), addr(301));
  const late = t0 + CATALOG_LIMITS.staleMs + 2000;
  for (let j = 0; j < CATALOG_LIMITS.maxEntriesPerPayTo; j++) d.record(payload(`https://junk.example/${j}`) as never, req(), new Date(late - 1000 + j), addr(1));
  assert.equal(d.record(payload("https://api.merchant.example/new") as never, req(), new Date(late), addr(302)).status, "rejected");
});

test("a full payTo of established listings refuses a one-payment newcomer, unless the weakest has gone stale", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0;
  const c = new Catalog(undefined, () => clock);
  for (let r = 0; r < CATALOG_LIMITS.maxEntriesPerPayTo; r++) {
    for (let p = 0; p < 3; p++) c.record(payload(`https://api.merchant.example/r${r}`) as never, req(), new Date(t0), addr(1000 + p));
  }
  const junk = c.record(payload("https://junk.example/x") as never, req(), new Date(t0 + 1), addr(1));
  assert.equal(junk.status, "rejected");
  assert.equal(junk.rejectedReason, "no room for this payTo");
  assert.equal(c.list({ payTo: merchant, limit: 100 }).pagination.total, CATALOG_LIMITS.maxEntriesPerPayTo);
  assert.ok(!c.list({ payTo: merchant, limit: 100 }).items.some((e) => e.resource.includes("junk")));

  clock = t0 + CATALOG_LIMITS.staleMs + 1;
  assert.equal(c.record(payload("https://api.merchant.example/new") as never, req(), new Date(clock), addr(2)).status, "success", "a stale entry makes way");
});

test("self-payments add a listing but no strength", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const c = new Catalog(undefined, () => t0);
  for (let r = 0; r < CATALOG_LIMITS.maxEntriesPerPayTo; r++) c.record(payload(`https://api.merchant.example/r${r}`) as never, req(), new Date(t0), addr(1000 + r));
  // The merchant paying itself many times does not make a listing stronger than one paid by a customer.
  for (let i = 0; i < 10; i++) c.record(payload("https://api.merchant.example/self") as never, req(), new Date(t0 + 1), merchant);
  assert.ok(!c.list({ payTo: merchant, limit: 100 }).items.some((e) => e.resource.endsWith("/self")));
});

test("one-off payments to fresh addresses cannot wipe a full catalog's established listings", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0 + 10_000;
  const c = new Catalog(undefined, () => clock);
  // A real merchant, paid by two customers.
  c.record(payload("https://api.merchant.example/v1") as never, req(), new Date(t0), addr(500_001));
  c.record(payload("https://api.merchant.example/v1") as never, req(), new Date(t0 + 1), addr(500_002));
  // An attacker fills the catalog and keeps going, each entry paid once, to a fresh address.
  for (let i = 0; i < CATALOG_LIMITS.maxEntries + 500; i++) {
    c.record(payload(`https://junk.example/${i}`, bazaar(), addr(i + 1)) as never, req(addr(i + 1)), new Date(t0 + 1000 + i), addr(900_000));
  }
  assert.equal(c.list({}).pagination.total, CATALOG_LIMITS.maxEntries);
  assert.equal(c.list({ payTo: merchant }).pagination.total, 1, "the established merchant listing survives");

  // Thirty days later, everything unpaid since has expired.
  clock = t0 + CATALOG_LIMITS.maxAgeMs + 10_000;
  c.record(payload("https://api.new.example/x", bazaar(), addr(999_999)) as never, req(addr(999_999)), new Date(clock), addr(3));
  assert.equal(c.list({}).pagination.total, 1);
});

test("a malformed declaration an earlier version accepted is dropped on load instead of stopping startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-p1-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const r = "https://api.example.com/x";
  const hostile = { schema: {}, info: { input: { type: "http", method: "GET", bodyType: { toString: null } } } };
  const good = "https://api.example.com/good";
  writeFileSync(path, JSON.stringify({
    [`GET ${r} eip155:24101 ${merchant.toLowerCase()}`]: { resource: r, type: "http", x402Version: 2, accepts: [req()], lastUpdated: new Date(now).toISOString(), extensions: { bazaar: hostile } },
    [`GET ${good} eip155:24101 ${merchant.toLowerCase()}`]: { resource: good, type: "http", x402Version: 2, accepts: [req()], lastUpdated: new Date(now).toISOString(), extensions: { bazaar: bazaar() } },
  }));
  const c = new Catalog(path, () => now);
  assert.deepEqual(c.list({}).items.map((e) => e.resource), [good]);
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 1, "the cleaned file is saved");
  // The same declaration in a new payment is rejected, not thrown.
  assert.equal(c.record(payload(r, hostile) as never, req(), undefined, addr(1)).status, "rejected");
});

test("a catalog file over the limits, or with path-only resources, is trimmed on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-trim-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const file: Record<string, unknown> = {};
  const entry = (resource: string, payTo: string, at: number, payments?: number) => ({
    resource, type: "http", x402Version: 2, accepts: [req(payTo)], lastUpdated: new Date(at).toISOString(), ...(payments ? { payments } : {}),
  });
  for (let i = 0; i < CATALOG_LIMITS.maxEntries + 100; i++) {
    const r = `https://junk.example/${i}`;
    file[`GET ${r} eip155:24101 ${addr(i + 1)}`] = entry(r, addr(i + 1), now - i);
  }
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo + 5; i++) {
    const r = `https://api.merchant.example/${i}`;
    file[`GET ${r} eip155:24101 ${merchant.toLowerCase()}`] = entry(r, merchant, now, 5);
  }
  file[`GET /weather/:city eip155:24101 ${merchant.toLowerCase()}`] = entry("/weather/:city", merchant, now, 9);
  file[`GET https://old.example/ eip155:24101 ${addr(7)}`] = entry("https://old.example/", addr(7), now - CATALOG_LIMITS.maxAgeMs - 1);
  writeFileSync(path, JSON.stringify(file));

  const c = new Catalog(path, () => now);
  assert.equal(c.list({}).pagination.total, CATALOG_LIMITS.maxEntries);
  assert.equal(c.list({ payTo: merchant }).pagination.total, CATALOG_LIMITS.maxEntriesPerPayTo, "the per-payTo cap holds, and the strongest are kept");
  assert.ok(!c.list({ payTo: merchant, limit: 100 }).items.some((e) => e.resource.startsWith("/")), "path-only resources are dropped");
  assert.ok(!("payments" in c.list({}).items[0]!), "the payment count is not served");
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, CATALOG_LIMITS.maxEntries, "the trimmed file is saved");
});

test("catalog writes happen in the background and flush() writes whatever is pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-save-"));
  const path = join(dir, "catalog.json");
  const c = new Catalog(path);
  c.record(payload("https://api.example.com/a") as never, req());
  assert.ok(!existsSync(path), "nothing is written synchronously on record");
  c.flush();
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 1);
  c.record(payload("https://api.example.com/b") as never, req());
  c.flush();
  const reloaded = new Catalog(path);
  assert.equal(reloaded.list({}).pagination.total, 2);
});

test("the whole entry has a size budget, and only the known requirements fields are listed", () => {
  const c = new Catalog();
  // Each field within its own limit, but a long URL, icon, description and extension together are over budget.
  const ext = bazaar();
  ext.info.pad = "x".repeat(CATALOG_LIMITS.maxExtensionChars - JSON.stringify(ext).length - 20);
  const big = payload(`https://api.example.com/${"p".repeat(2_000)}`, ext) as unknown as { resource: Record<string, unknown> };
  big.resource.description = "W".repeat(CATALOG_LIMITS.maxDescriptionChars);
  big.resource.iconUrl = `https://img.example.com/${"i".repeat(2_000)}.png`;
  const r = c.record(big as never, req());
  assert.equal(r.status, "rejected");
  assert.match(r.rejectedReason ?? "", /over/);
  // extra keeps only what a scheme defines, so it cannot bloat or mislabel a listing.
  const bloated = { ...req(), extra: { pad: "x".repeat(CATALOG_LIMITS.maxEntryChars) } };
  assert.equal(c.record(payload("https://api.example.com/padded") as never, bloated as never).status, "success");
  assert.ok(!("extra" in c.list({}).items.find((i) => i.resource.endsWith("/padded"))!.accepts[0]!), "an incentiv-eoa-tx listing has no extra");
  const extraField = { ...req(), junk: "y".repeat(100) };
  assert.equal(c.record(payload("https://api.example.com/ok") as never, extraField as never).status, "success");
  assert.ok(!("junk" in c.list({}).items.find((i) => i.resource.endsWith("/ok"))!.accepts[0]!), "unknown requirements fields are dropped");
});

test("entries loaded from an earlier version go through the current rules, and the file is rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-legacy-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const r = "https://api.example.com/weather";
  const legacy = {
    resource: r, type: "http", x402Version: 2, accepts: [req()], lastUpdated: new Date(now).toISOString(),
    description: "d".repeat(CATALOG_LIMITS.maxDescriptionChars + 1),
    extensions: { bazaar: bazaar(), other: { secret: "kept by the old writer" } },
  };
  writeFileSync(path, JSON.stringify({ [`GET ${r} eip155:24101 ${merchant.toLowerCase()}`]: legacy }));
  const item = new Catalog(path, () => now).list({}).items[0]!;
  assert.deepEqual(Object.keys(item.extensions ?? {}), ["bazaar"], "non-Bazaar extensions are dropped");
  assert.equal(item.description, undefined, "an over-long description is dropped");
  const saved = Object.values(JSON.parse(readFileSync(path, "utf8")) as Record<string, { extensions: object }>)[0]!;
  assert.deepEqual(Object.keys(saved.extensions), ["bazaar"], "the file is rewritten even though the entry count is unchanged");
});

test("expiry applies below capacity, on reads, and before choosing which entry makes way", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0;
  const c = new Catalog(undefined, () => clock);
  c.record(payload("https://api.example.com/old") as never, req());
  assert.equal(c.list({}).pagination.total, 1);
  clock = t0 + CATALOG_LIMITS.maxAgeMs + 1;
  assert.equal(c.list({}).pagination.total, 0, "a stale entry is not listed");
  assert.equal(c.search({ query: "" }).resources.length, 0, "or found");
  // search() expires on its own, without a list() first.
  clock = t0;
  const s = new Catalog(undefined, () => clock);
  s.record(payload("https://api.example.com/old") as never, req());
  clock = t0 + CATALOG_LIMITS.maxAgeMs + 1;
  assert.equal(s.search({ query: "" }).resources.length, 0, "search expires entries itself");

  // A once-popular route that expired must not push out a recent one at the per-payTo cap.
  clock = t0;
  const d = new Catalog(undefined, () => clock);
  for (let i = 0; i < 10; i++) d.record(payload("https://api.example.com/popular") as never, req());
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo - 1; i++) d.record(payload(`https://api.example.com/r${i}`) as never, req(), new Date(t0 + CATALOG_LIMITS.maxAgeMs));
  clock = t0 + CATALOG_LIMITS.maxAgeMs + 1;
  d.record(payload("https://api.example.com/new") as never, req());
  const urls = d.list({ payTo: merchant, limit: 100 }).items.map((e) => e.resource);
  assert.ok(!urls.includes("https://api.example.com/popular"));
  assert.ok(urls.includes("https://api.example.com/new"));
  assert.equal(urls.length, CATALOG_LIMITS.maxEntriesPerPayTo);
});

test("a background write that finishes after a newer flush never replaces it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-race-"));
  const path = join(dir, "catalog.json");
  const c = new Catalog(path);
  c.record(payload("https://api.example.com/a") as never, req());
  // The background writer takes its snapshot (A only) synchronously, then awaits the disk.
  const pending = (c as unknown as { writeInBackground(): Promise<void> }).writeInBackground();
  // Meanwhile B is recorded and the shutdown flush writes A and B.
  c.record(payload("https://api.example.com/b") as never, req());
  c.flush();
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 2);
  // The older A-only snapshot finishes last and must not replace the file.
  await pending;
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 2, "the older snapshot replaced the newer file");
});

test("legacy MCP declarations are not kept as http listings", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-mcp-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const r = "https://api.example.com/mcp";
  const mcp = { info: { input: { type: "mcp", toolName: "weather", inputSchema: { type: "object" } } }, schema: {} };
  const entry = { resource: r, type: "http", x402Version: 2, accepts: [req()], lastUpdated: new Date(now).toISOString(), extensions: { bazaar: mcp } };
  writeFileSync(path, JSON.stringify({ [`GET ${r} eip155:24101 ${merchant.toLowerCase()}`]: entry }));
  assert.equal(new Catalog(path, () => now).list({}).pagination.total, 0);
  // And a new payment that declares one is refused.
  const rec = new Catalog().record(payload(r, mcp) as never, req());
  assert.equal(rec.rejectedReason, "only http resources are cataloged");
});

test("description and mimeType cannot carry control characters or bidi overrides", () => {
  const c = new Catalog();
  const ext = bazaar();
  const p = payload("https://api.example.com/x", ext) as unknown as { resource: { description: string; mimeType: string } };
  p.resource.description = "ok\u0000\u001b[31m\u202Eevil";
  p.resource.mimeType = "application/json\r\nX-Injected: 1";
  assert.equal(c.record(p as never, req()).status, "success");
  const item = c.list({}).items[0]!;
  assert.equal(item.description, undefined);
  assert.equal(item.mimeType, undefined);
  const q = payload("https://api.example.com/y", bazaar()) as unknown as { resource: { description: string; mimeType: string } };
  q.resource.description = "Two\nlines";
  q.resource.mimeType = "application/json; charset=utf-8";
  c.record(q as never, req());
  const ok = c.list({}).items.find((e) => e.resource.endsWith("/y"))!;
  assert.equal(ok.description, "Two lines");
  assert.equal(ok.mimeType, "application/json; charset=utf-8");
});

test("an unreadable catalog file is moved aside and the catalog starts empty", () => {
  for (const content of ["{\"truncated", "null", "[]"]) {
    const dir = mkdtempSync(join(tmpdir(), "x402-corrupt-"));
    const path = join(dir, "catalog.json");
    writeFileSync(path, content);
    const logged: Record<string, unknown>[] = [];
    const c = new Catalog(path, Date.now, (l) => logged.push(l));
    assert.equal(c.list({}).pagination.total, 0);
    const aside = readdirSync(dir).filter((f) => f.startsWith("catalog.json.corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]!), "utf8"), content);
    assert.ok(logged.some((l) => l.event === "catalog_load_failed" && l.movedTo === join(dir, aside[0]!)));
  }
  // A second bad file does not replace the first.
  const dir = mkdtempSync(join(tmpdir(), "x402-corrupt2-"));
  const path = join(dir, "catalog.json");
  writeFileSync(path, "first");
  new Catalog(path, () => 1_000, () => {});
  writeFileSync(path, "second");
  new Catalog(path, () => 2_000, () => {});
  assert.equal(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 2);
});

test("a stored date that is not ISO is dropped, and one in the future is brought back to now", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-date-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const entry = (resource: string, lastUpdated: string) => ({ resource, type: "http", x402Version: 2, accepts: [req()], lastUpdated });
  const k = (r: string) => `GET ${r} eip155:24101 ${merchant.toLowerCase()}`;
  writeFileSync(path, JSON.stringify({
    [k("https://a.example/")]: entry("https://a.example/", "zzzz"),
    [k("https://b.example/")]: entry("https://b.example/", "9999-01-01T00:00:00.000Z"),
  }));
  const items = new Catalog(path, () => now).list({}).items;
  assert.deepEqual(items.map((e) => [e.resource, e.lastUpdated]), [["https://b.example/", new Date(now).toISOString()]]);
});

test("payers are stored as counts, and the earlier list of addresses still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-payers-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const r = "https://api.example.com/x";
  const key = `GET ${r} eip155:24101 ${merchant.toLowerCase()}`;
  writeFileSync(path, JSON.stringify({ [key]: { resource: r, type: "http", x402Version: 2, accepts: [req()], lastUpdated: new Date(now).toISOString(), payers: [addr(1), addr(2), "junk"] } }));
  const c = new Catalog(path, () => now);
  const strength = () => (c as unknown as { strength(k: string): number }).strength(key);
  assert.equal(strength(), 2);
  for (let i = 0; i < 10; i++) c.record(payload(r) as never, req(), new Date(now), addr(1));
  assert.equal(strength(), 1 + CATALOG_LIMITS.maxPaymentsPerPayer);
  c.flush();
  const saved = Object.values(JSON.parse(readFileSync(path, "utf8")) as Record<string, { payers: Record<string, number> }>)[0]!;
  assert.deepEqual(saved.payers, { [addr(1)]: CATALOG_LIMITS.maxPaymentsPerPayer, [addr(2)]: 1 });
});

test("the facilitators settle USDC payments of at least one atomic unit only", async () => {
  const eoa = new IncentivEoaTxFacilitatorScheme();
  const userop = new IncentivUserOpFacilitatorScheme();
  const base = { ...req(), extra: { entryPoint: MAINNET.entryPoint } };
  const verify = (s: { verify: (p: never, r: never) => Promise<{ invalidReason?: string }> }, r: Record<string, unknown>, scheme: string) =>
    s.verify({ x402Version: 2, accepted: { ...r, scheme }, payload: {} } as never, { ...r, scheme } as never);
  for (const [s, scheme] of [[eoa, "incentiv-eoa-tx"], [userop, "incentiv-userop"]] as const) {
    assert.equal((await verify(s, { ...base, amount: "0" }, scheme)).invalidReason, "invalid_payment_requirements");
    assert.equal((await verify(s, { ...base, amount: "-1" }, scheme)).invalidReason, "invalid_payment_requirements");
    assert.equal((await verify(s, { ...base, asset: "0x0000000000000000000000000000000000000001" }, scheme)).invalidReason, "asset_mismatch");
  }
});

test("the original error behind a sanitized refusal is logged, with URLs cut to their host", () => {
  const logged: Record<string, unknown>[] = [];
  const s = new IncentivEoaTxFacilitatorScheme({ log: (l) => logged.push(l) });
  const cause = new Error("HTTP request failed.\nURL: https://rpc.example/v2/SECRETKEY?x=1\nDetails: rate limited");
  const r = (s as unknown as { invalid(e: unknown): { invalidMessage?: string } }).invalid(new PaymentError("transfer_gate_unavailable", publicMessage(cause), cause));
  assert.equal(r.invalidMessage, "HTTP request failed.");
  const line = String(logged.find((l) => l.event === "payment_error")?.error);
  assert.ok(line.includes("rate limited") && line.includes("https://rpc.example/…"), line);
  assert.ok(!line.includes("SECRETKEY"), "the API key does not reach the log");
  assert.equal(logMessage(new Error("see wss://node.example/ws/KEY now")), "see wss://node.example/… now");
});

test("logMessage drops credentials written into a URL", () => {
  assert.equal(logMessage(new Error("URL: https://user:SECRET@rpc.example/v2/KEY")), "URL: https://rpc.example/…");
  assert.equal(logMessage(new Error("at https://:token@rpc.example")), "at https://rpc.example/…");
  assert.equal(logMessage(new Error("https://user:SEC@RETPASS@rpc.example/v2/KEY")), "https://rpc.example/…", "an unencoded @ in the password");
  assert.equal(logMessage(new Error("mail a@b.example via https://rpc.example/x?k=1")), "mail a@b.example via https://rpc.example/…");
  assert.equal(logMessage(new Error("at http://[2001:db8::1]:8545/v2/SECRETKEY")), "at http://[2001:db8::1]:8545/…", "an IPv6 host");
  assert.equal(logMessage(new Error("https://rpc.example/v2/SECRET]KEYTAIL x")), "https://rpc.example/… x", "a ] in the path");
  assert.equal(logMessage(new Error("(https://rpc.example/v2/SECRET)KEYTAIL)")), "(https://rpc.example/…", "a ) in the path");
  assert.equal(logMessage(new Error("bad http://[::1/KEY x")), "bad http://<url> x", "an unparsable URL is replaced whole");
  assert.equal(logMessage(new Error("https://rpc.example/v2/SEC'RETTAIL x")), "https://rpc.example/… x", "an apostrophe in the path");
  assert.equal(logMessage(new Error("https://rpc.example/v2/SEC`RETTAIL x")), "https://rpc.example/… x", "a backtick in the path");
  assert.equal(
    logMessage(new Error('{"url":"https://b.example/KEY","code":-32602,"message":"AA21 didn\'t pay prefund"}')),
    '{"url":"https://b.example/…","code":-32602,"message":"AA21 didn\'t pay prefund"}',
    "a URL inside JSON keeps the fields after it",
  );
});

test("a malformed asset is asset_mismatch, not an internal error", async () => {
  const s = new IncentivEoaTxFacilitatorScheme();
  const r = { ...req(), asset: "usdc" };
  const v = await s.verify({ x402Version: 2, accepted: r, payload: {} } as never, r as never);
  assert.equal(v.invalidReason, "asset_mismatch");
});

test("a store write that fails is rolled back, so memory never holds what the file does not", () => {
  class FlakyStore extends MemoryStore {
    failing = false;
    protected override save() {
      if (this.failing) throw new Error("ENOSPC: no space left on device");
    }
  }
  const s = new FlakyStore();
  s.claim("0xAA");
  s.failing = true;
  assert.throws(() => s.set("0xaa", { success: true } as never), /ENOSPC/);
  assert.equal(s.get("0xaa"), undefined, "the result is not kept");
  assert.ok(s.isClaimed("0xaa"), "the claim is kept, so a resend can record it later");
  assert.throws(() => s.claim("0xbb"), /ENOSPC/);
  assert.ok(!s.isClaimed("0xbb"));
  assert.throws(() => s.release("0xaa"), /ENOSPC/);
  assert.ok(s.isClaimed("0xaa"));
  // Overwriting a result that fails to save restores the earlier one.
  s.failing = false;
  s.set("0xcc", { success: false, errorReason: "first" } as never);
  s.failing = true;
  assert.throws(() => s.set("0xcc", { success: true } as never), /ENOSPC/);
  assert.equal(s.get("0xcc")?.errorReason, "first");
});

test("a success is reported only once it is recorded; a resend reports it once storage works", async () => {
  class FlakyStore extends MemoryStore {
    failing = true;
    protected override save() {
      if (this.failing) throw new Error("EROFS: read-only file system");
    }
  }
  const store = new FlakyStore();
  store.failing = false;
  const hash = `0x${"ab".repeat(32)}`;
  store.claim(hash);
  store.failing = true;
  const logged: Record<string, unknown>[] = [];
  const s = new IncentivEoaTxFacilitatorScheme({ store, log: (l) => logged.push(l) });
  // The transaction is on chain, submitted by this facilitator (it holds the claim).
  (s as unknown as { chain: unknown }).chain = { client: { getTransactionReceipt: async () => paidReceipt } };
  const d = { txHash: hash, sender: merchant, ...payment };
  const settleOnce = (s as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ success: boolean; errorReason?: string }> }).settleOnce.bind(s);
  const first = await settleOnce(d, req());
  assert.equal(first.success, false);
  assert.equal(first.errorReason, "settle_unrecorded");
  assert.ok(logged.some((l) => l.event === "store_error"));
  store.failing = false;
  assert.equal((await settleOnce(d, req())).success, true, "the resend records and reports it");
  assert.equal(store.get(hash)?.success, true);
});

test("an entry that expired starts again from no payers", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0;
  const c = new Catalog(undefined, () => clock);
  for (let i = 0; i < 5; i++) c.record(payload("https://api.example.com/x") as never, req(), undefined, addr(10 + i));
  const strength = () => (c as unknown as { strength(k: string): number }).strength(`GET https://api.example.com/x eip155:24101 ${merchant.toLowerCase()}`);
  assert.equal(strength(), 5);
  clock = t0 + CATALOG_LIMITS.maxAgeMs + 1;
  c.record(payload("https://api.example.com/x") as never, req(), undefined, addr(99));
  assert.equal(strength(), 1);
});

test("temporary files left by an interrupted write are removed on startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-tmp-"));
  const path = join(dir, "catalog.json");
  writeFileSync(`${path}.7.tmp`, "{}");
  writeFileSync(`${path}.sync.tmp`, "{}");
  writeFileSync(join(dir, "other.tmp"), "{}");
  new Catalog(path);
  assert.ok(!existsSync(`${path}.7.tmp`) && !existsSync(`${path}.sync.tmp`));
  assert.ok(existsSync(join(dir, "other.tmp")), "unrelated files are left alone");
});

test("search refuses long queries", () => {
  const c = new Catalog();
  c.record(payload("https://api.example.com/weather") as never, req());
  assert.equal(c.search({ query: "weather api" }).resources.length, 1);
  assert.throws(() => c.search({ query: "a ".repeat(CATALOG_LIMITS.maxQueryWords + 1) }), QueryTooLongError);
  assert.throws(() => c.search({ query: "a".repeat(CATALOG_LIMITS.maxQueryChars + 1) }), QueryTooLongError);
});

test("publicMessage keeps one line and removes URLs", () => {
  const e = new Error("HTTP request failed.\n\nURL: https://rpc.example/v2/SECRETKEY\nRequest body: {}");
  assert.equal(publicMessage(e), "HTTP request failed.");
  assert.equal(publicMessage(new Error("failed at https://rpc.example/v2/SECRETKEY now")), "failed at <url> now");
  assert.equal(publicMessage(Object.assign(new Error("long\ndetails"), { shortMessage: "short" })), "short");
  // viem puts a revert reason on the second line of shortMessage.
  const revert = Object.assign(new Error("x"), { shortMessage: 'The contract function "checkApproval" reverted with the following reason:\npaused' });
  assert.equal(publicMessage(revert), 'The contract function "checkApproval" reverted with the following reason: paused');
});

async function serve(app: import("express").Express) {
  const server = app.listen(0);
  await new Promise<void>((ok) => server.once("listening", () => ok()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

test("a catalog failure never turns a successful settle into an error, and errors carry no internals", async () => {
  const catalog = new Catalog();
  catalog.record = () => {
    throw new Error("disk full at /data/catalog.json");
  };
  const logged: Record<string, unknown>[] = [];
  const { app, eoaScheme } = createFacilitatorApp({ discovery: true, catalog, discoveryPerMinute: 2, log: (l) => logged.push(l) });
  const settled = { success: true, payer: merchant, transaction: "0x01", network: "eip155:24101", amount: "1" };
  eoaScheme.settle = async () => settled as never;
  const { base, close } = await serve(app);
  try {
    const post = (path: string, body: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body });
    const p = payload("https://api.example.com/weather");
    const r = await post("/settle", JSON.stringify({ paymentPayload: p, paymentRequirements: req() }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), settled);
    const ext = JSON.parse(Buffer.from(r.headers.get("extension-responses") ?? "", "base64").toString()) as { bazaar: { status: string; rejectedReason: string } };
    assert.equal(ext.bazaar.status, "rejected");
    assert.ok(!ext.bazaar.rejectedReason.includes("/data"), "the catalog error is not sent to the merchant");
    assert.ok(logged.some((l) => l.event === "catalog_error"));

    // A rejection built from payer input must not grow the header: the reason is fixed and short.
    const hostile = bazaar();
    (hostile.info as { input: Record<string, unknown> }).input.method = "X".repeat(3_000);
    catalog.record = Catalog.prototype.record.bind(new Catalog());
    const r2 = await post("/settle", JSON.stringify({ paymentPayload: payload("https://api.example.com/weather", hostile), paymentRequirements: req() }));
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), settled, "the merchant still receives the settlement");
    const header = r2.headers.get("extension-responses") ?? "";
    assert.ok(header.length < 200, `EXTENSION-RESPONSES is ${header.length} bytes`);
    assert.ok(logged.some((l) => l.event === "catalog_rejected" && String(l.detail).includes("XXXX")), "the detail goes to the log");
    // A refusal without a detail is logged too.
    catalog.record = () => ({ status: "rejected", rejectedReason: "no room in the catalog" });
    await post("/settle", JSON.stringify({ paymentPayload: p, paymentRequirements: req() }));
    assert.ok(logged.some((l) => l.event === "catalog_rejected" && l.reason === "no room in the catalog" && !("detail" in l)));

    const bad = await post("/verify", "{not json");
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "invalid_request" });

    const unknown = await post("/verify", JSON.stringify({ paymentPayload: { ...p, accepted: { ...req(), scheme: "nope" } }, paymentRequirements: { ...req(), scheme: "nope" } }));
    const text = await unknown.text();
    assert.ok(!/at .*\.ts:\d+/.test(text) && !text.includes("node_modules"), `no stack trace: ${text}`);
    assert.equal(unknown.status, 400, "an unsupported scheme is the client's mistake");
    for (const [pp, rr] of [
      [{ ...p, x402Version: 1 }, req()],
      [{ ...p, accepted: { ...req(), network: "eip155:1" } }, { ...req(), network: "eip155:1" }],
    ] as const) {
      const r = await post("/verify", JSON.stringify({ paymentPayload: pp, paymentRequirements: rr }));
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: "unsupported_scheme" });
    }
    assert.deepEqual(JSON.parse(text), { error: "unsupported_scheme" });

    const long = await fetch(`${base}/discovery/search?query=${"a+".repeat(20)}`);
    assert.equal(long.status, 400);
    assert.equal((await fetch(`${base}/discovery/resources`)).status, 200);
    assert.equal((await fetch(`${base}/discovery/resources`)).status, 429, "discovery is rate limited");
  } finally {
    await close();
  }
});

test("within a payTo, strength is the USDC paid, so junk at the payer-count cap cannot lock out a merchant's route", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const c = new Catalog(undefined, () => t0 + 100_000);
  // 50 junk routes, each paid 4 times by each of 32 attacker addresses: the payer-count cap, 128 units each.
  for (let j = 0; j < CATALOG_LIMITS.maxEntriesPerPayTo; j++) {
    for (let p = 0; p < CATALOG_LIMITS.maxPayersTracked; p++) {
      for (let i = 0; i < CATALOG_LIMITS.maxPaymentsPerPayer; i++) c.record(payload(`https://junk.example/${j}`) as never, req(), new Date(t0 + j), addr(1 + p));
    }
  }
  assert.equal(c.list({ payTo: merchant, limit: 100 }).pagination.total, CATALOG_LIMITS.maxEntriesPerPayTo);
  // A route priced at 200 units gets in on its first customer.
  const priced = { ...req(), amount: "200" };
  assert.equal(c.record(payload("https://api.merchant.example/pro") as never, priced, new Date(t0 + 1000), addr(500)).status, "success");
  // A 1-unit route gets in once its customers have paid more than the weakest junk route: 129 payments here.
  const results: string[] = [];
  for (let i = 0; i < 129; i++) results.push(c.record(payload("https://api.merchant.example/cheap") as never, req(), new Date(t0 + 2000 + i), addr(600 + (i % 3))).status);
  assert.equal(results.indexOf("success"), 128);
});

test("refused junk at another payTo cannot make the catalog forget a merchant route's remembered strength", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const c = new Catalog(undefined, () => t0 + 100_000);
  const attacker = addr(777);
  for (const payTo of [merchant, attacker]) {
    for (let j = 0; j < CATALOG_LIMITS.maxEntriesPerPayTo; j++) {
      for (const p of [1, 2]) c.record(payload(`https://junk.example/${j}`, bazaar(), payTo) as never, req(payTo), new Date(t0 + j), addr(p));
    }
  }
  // The merchant's new route has been paid twice, which ties the junk, so it is refused and remembered.
  for (const p of [300, 301]) c.record(payload("https://api.merchant.example/new") as never, req(), new Date(t0 + 1000 + p), addr(p));
  // Flood: more refused keys than maxPendingKeys, at the attacker's payTo and at the merchant's.
  for (let i = 0; i < CATALOG_LIMITS.maxPendingKeys + 100; i++) {
    const payTo = i % 2 ? attacker : merchant;
    c.record(payload(`https://flood.example/${i}`, bazaar(), payTo) as never, req(payTo), new Date(t0 + 2000 + i), addr(3));
  }
  assert.equal(c.record(payload("https://api.merchant.example/new") as never, req(), new Date(t0 + 9000), addr(302)).status, "success");
});

test("only schema positions are checked for regular expressions, and a too-deep schema has its own reason", () => {
  const c = new Catalog();
  const withSchema = (schema: unknown) => {
    const ext = bazaar();
    ext.schema = schema;
    return ext;
  };
  const ok = (schema: unknown, url: string) => c.record(payload(url, withSchema(schema)) as never, req());
  assert.equal(ok({ type: "object", properties: { patternProperties: { type: "string" } } }, "https://a.example/1").status, "success");
  assert.equal(ok({ type: "object", default: { pattern: "^(a+)+$" }, examples: [{ pattern: "x" }] }, "https://a.example/2").status, "success");
  assert.equal(ok({ anyOf: [{ type: "string" }, { items: { pattern: "^x" } }] }, "https://a.example/3").rejectedReason, "the discovery schema may not use regular expressions");
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 40; i++) deep = { not: deep };
  assert.equal(ok(deep, "https://a.example/4").rejectedReason, "the discovery schema is nested too deeply");
});

test("a stored schema with a regular expression is dropped on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-loadregex-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const r = "https://api.example.com/x";
  const ext = bazaar();
  ext.schema = { type: "object", properties: { x: { type: "string", pattern: "^(a+)+$" } } };
  writeFileSync(path, JSON.stringify({ [`GET ${r} eip155:24101 ${merchant.toLowerCase()}`]: { resource: r, type: "http", x402Version: 2, accepts: [req()], lastUpdated: new Date(now).toISOString(), extensions: { bazaar: ext } } }));
  assert.equal(new Catalog(path, () => now).list({}).pagination.total, 0);
});

test("zero-width characters and Unicode separators are handled, and mimeType must have the MIME form", () => {
  const c = new Catalog();
  const rec = (url: string, description: string, mimeType?: string) => {
    const p = payload(url) as unknown as { resource: { description: string; mimeType?: string } };
    p.resource.description = description;
    if (mimeType !== undefined) p.resource.mimeType = mimeType;
    c.record(p as never, req());
    return c.list({ limit: 100 }).items.find((e) => e.resource === url)!;
  };
  assert.equal(rec("https://a.example/zw", "pay\u200Bpal").description, undefined);
  assert.equal(rec("https://a.example/bom", "x\uFEFFy").description, undefined);
  assert.equal(rec("https://a.example/ls", "one\u2028two").description, "one two");
  assert.equal(rec("https://a.example/m1", "d", "application json").mimeType, undefined);
  assert.equal(rec("https://a.example/m2", "d", "json").mimeType, undefined);
  assert.equal(rec("https://a.example/m3", "d", "text/plain").mimeType, "text/plain");
});

class FlakyStore extends MemoryStore {
  failing = false;
  protected override save() {
    if (this.failing) throw new Error("EROFS: read-only file system");
  }
}

/** A stand-in bundler that answers eth_getUserOperationReceipt with `receipt`. */
async function fakeBundler(receipt: unknown, fail?: (method: string) => boolean) {
  const methods: string[] = [];
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      methods.push(method);
      if (fail?.(method)) return void res.writeHead(503).end("receipt RPC unavailable");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: typeof receipt === "function" ? receipt(method) : receipt }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), methods };
}

const opHash: Hex = `0x${"cd".repeat(32)}`;
const beforeExecution = { address: MAINNET.entryPoint, topics: encodeEventTopics({ abi: entryPointAbi, eventName: "BeforeExecution" }), data: "0x" };
const operationEvent = (userOpHash = opHash, success = true, sender: Address = merchant, nonce = 0n) => ({
  address: MAINNET.entryPoint,
  topics: encodeEventTopics({ abi: entryPointAbi, eventName: "UserOperationEvent", args: { userOpHash, sender, paymaster: zeroAddress } }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [nonce, success, 0n, 0n]),
});
const userOpScheme = (store: MemoryStore, bundlerUrl: string, logged: Record<string, unknown>[] = []) => {
  const s = new IncentivUserOpFacilitatorScheme({ store, log: (l) => logged.push(l) });
  const op = { sender: merchant, nonce: 0n, callData: "0x", callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: "0x" };
  const parsed = { op, userOpHash: opHash, decoded: payment, payer: merchant, validUntil: Math.floor(Date.now() / 1000) + 60, maxTimeoutSeconds: 120 };
  Object.assign(s, {
    chain: { config: { ...MAINNET, bundlerUrl }, client: {
      getTransactionReceipt: async () => ({ status: "success", logs: [beforeExecution, transferLog(), operationEvent()] }),
    } },
    parse: () => parsed,
    checkChain: async () => parsed,
    nonceUsed: async () => false,
  });
  return s;
};
const opPayload = { x402Version: 2, accepted: req(), payload: { userOpHash: opHash } };

test("EOA settlement requires the exact USDC transfer", async () => {
  const cases = [
    [],
    [transferLog({ ...payment, token: zeroAddress })],
    [transferLog(payment, zeroAddress)],
    [transferLog({ ...payment, to: zeroAddress })],
    [transferLog({ ...payment, amount: 2n })],
    [transferLog()],
  ];
  for (const [index, logs] of cases.entries()) {
    const store = new MemoryStore();
    const txHash = `0x${String(index + 1).repeat(64)}`;
    const scheme = new IncentivEoaTxFacilitatorScheme({ store });
    store.claim(txHash);
    Object.assign(scheme, {
      parse: async () => ({ txHash, sender: merchant, ...payment }),
      chain: { client: { getTransactionReceipt: async () => ({ status: "success", logs }) } },
    });
    const valid = index === cases.length - 1;
    assert.equal((await scheme.verify({} as never, req())).isValid, valid);
    const result = await scheme.settle({} as never, req());
    assert.equal(result.success, valid);
    assert.equal(result.errorReason, valid ? undefined : "payment_transfer_missing");
  }
});

test("user operation settlement uses only its own execution logs and requires a successful event", async () => {
  const otherHash: Hex = `0x${"ef".repeat(32)}`;
  const bundleHash = `0x${"11".repeat(32)}`;
  const bundler = await fakeBundler({ success: true, receipt: { transactionHash: bundleHash } });
  try {
    const transfer = transferLog();
    const cases = [
      { logs: [transfer, beforeExecution, operationEvent()], reason: "payment_transfer_missing" },
      { logs: [beforeExecution, transfer, operationEvent(otherHash), operationEvent()], reason: "payment_transfer_missing" },
      { logs: [beforeExecution, operationEvent(), transfer, operationEvent(otherHash)], reason: "payment_transfer_missing" },
      { logs: [beforeExecution, transfer, operationEvent(opHash, false)], reason: "userop_reverted" },
      { logs: [beforeExecution, operationEvent(otherHash), transfer, operationEvent()], reason: undefined },
    ];
    for (const { logs, reason } of cases) {
      const store = new MemoryStore();
      const scheme = userOpScheme(store, bundler.url);
      store.claim(opHash);
      Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          assert.equal(hash, bundleHash);
          return { status: "success", logs };
        },
      });
      if (reason === "payment_transfer_missing") {
        assert.equal((await scheme.verify(opPayload as never, req())).invalidReason, reason);
      }
      const result = await scheme.settle(opPayload as never, req());
      assert.equal(result.errorReason, reason);
      assert.equal(result.success, reason === undefined);
    }
  } finally {
    bundler.close();
  }
});

test("an unverified bundle keeps the claim until the operation's own receipt appears", async () => {
  const transactionHash = `0x${"11".repeat(32)}`;
  const bundler = await fakeBundler({ success: true, receipt: { transactionHash } });
  try {
    const transfer = transferLog();
    const otherHash: Hex = `0x${"ef".repeat(32)}`;
    const valid = { status: "success", logs: [beforeExecution, transfer, operationEvent()] };
    const cases = [
      { status: "reverted", logs: [] },
      { status: "success", logs: [beforeExecution, transfer, operationEvent(otherHash)] },
      { status: "success", logs: [beforeExecution, transfer, operationEvent(opHash, true, zeroAddress)] },
      { status: "success", logs: [beforeExecution, transfer, operationEvent(opHash, true, merchant, 1n)] },
      { status: "success", logs: [{ ...beforeExecution, address: zeroAddress }, transfer, operationEvent()] },
      { status: "success", logs: [beforeExecution, transfer, { ...operationEvent(), address: zeroAddress }] },
    ];
    for (const candidate of cases) {
      const store = new MemoryStore();
      store.claim(opHash);
      const scheme = userOpScheme(store, bundler.url);
      let chainReceipt = candidate;
      Object.assign(scheme, {
        settleTimeoutMs: 150,
        pollIntervalMs: 10,
        checkChain: async () => { throw new PaymentError("nonce_used", "account nonce advanced"); },
      });
      Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
        getTransactionReceipt: async () => chainReceipt,
      });
      assert.equal((await scheme.settle(opPayload as never, req())).errorReason, "settle_timeout");
      assert.equal(store.get(opHash), undefined);
      assert.ok(store.isClaimed(opHash));
      chainReceipt = valid;
      assert.equal((await scheme.settle(opPayload as never, req())).success, true);
      assert.equal((await scheme.settle(opPayload as never, req())).errorReason, "already_settled");
    }
  } finally {
    bundler.close();
  }
});

test("a located bundle blocks new claims and lets existing claims wait for chain confirmation", async () => {
  const bundleHash: Hex = `0x${"11".repeat(32)}`;
  let locations = 0;
  const bundler = await fakeBundler(() => ++locations <= 2 ? { success: true, receipt: { transactionHash: bundleHash } } : null);
  try {
    const store = new MemoryStore();
    const scheme = userOpScheme(store, bundler.url);
    let reads = 0;
    Object.assign(scheme, { settleTimeoutMs: 1_000, pollIntervalMs: 10 });
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        assert.equal(hash, bundleHash);
        if (++reads < 3) throw new Error("chain receipt is not visible yet");
        return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
      },
    });

    const unclaimed = await scheme.settle(opPayload as never, req());
    assert.equal(unclaimed.errorReason, "already_settled");
    assert.equal(unclaimed.transaction, bundleHash);
    assert.equal(reads, 0);
    assert.equal(store.isClaimed(opHash), false);

    store.claim(opHash);
    assert.equal((await scheme.settle(opPayload as never, req())).success, true);
    assert.equal(reads, 3);
    assert.equal((await scheme.settle(opPayload as never, req())).errorReason, "already_settled");
    assert.ok(!bundler.methods.includes("eth_sendUserOperation"));
  } finally {
    bundler.close();
  }
});

test("verify-first recovery accepts an expired claimed operation while the chain receipt catches up", async () => {
  const located = { success: true, receipt: { transactionHash: `0x${"11".repeat(32)}` } };
  const bundler = await fakeBundler((method: string) => method === "eth_getUserOperationReceipt" ? located : null);
  try {
    const store = new MemoryStore();
    const scheme = userOpScheme(store, bundler.url);
    let visible = false;
    Object.assign(scheme, { checkDeadline: () => { throw new PaymentError("payment_expired", "validUntil has passed"); } });
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async () => {
        if (!visible) throw new Error("receipt RPC is behind");
        return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
      },
    });
    assert.equal((await scheme.verify(opPayload as never, req())).invalidReason, "payment_expired");
    store.claim(opHash);
    assert.equal((await scheme.verify(opPayload as never, req())).isValid, true);
    visible = true;
    assert.equal((await scheme.settle(opPayload as never, req())).success, true);
    assert.ok(!bundler.methods.includes("eth_sendUserOperation"));
  } finally {
    bundler.close();
  }
});

test("verify does not treat malformed or reverted bundle locations as payment proof", async () => {
  const validHash: Hex = `0x${"11".repeat(32)}`;
  for (const [hash, status, expected] of [
    ["17", "success", "payment_expired"],
    ["not-a-hash", "success", "payment_expired"],
    [validHash, "reverted", "payment_expired"],
    [validHash, "unavailable", undefined],
  ] as const) {
    const bundler = await fakeBundler((method: string) => method === "eth_getUserOperationReceipt"
      ? { success: false, receipt: { transactionHash: hash } } : null);
    try {
      const store = new MemoryStore();
      store.claim(opHash);
      const scheme = userOpScheme(store, bundler.url);
      Object.assign(scheme, {
        checkDeadline: () => { throw new PaymentError("payment_expired", "validUntil has passed"); },
        mayStillLand: async () => false,
      });
      Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
        getTransactionReceipt: async () => {
          if (status === "unavailable") throw new Error("chain RPC is behind");
          return { status, logs: [] };
        },
      });
      const response = await scheme.verify(opPayload as never, req());
      assert.equal(response.invalidReason, expected);
      assert.equal(response.isValid, expected === undefined);
    } finally {
      bundler.close();
    }
  }
});

test("verify keeps a claimed payment retryable when a stale bundle has no matching operation", async () => {
  const bundleHash: Hex = `0x${"11".repeat(32)}`;
  for (const chainReceipt of [
    { status: "success", logs: [beforeExecution, operationEvent(`0x${"ef".repeat(32)}`)] },
    { status: "success", logs: null },
    { status: "reverted", logs: [] },
  ]) {
    const bundler = await fakeBundler((method: string) => method === "eth_getUserOperationReceipt"
      ? { receipt: { transactionHash: bundleHash } } : null);
    try {
    const store = new MemoryStore();
    store.claim(opHash);
    const scheme = userOpScheme(store, bundler.url);
    Object.assign(scheme, {
      checkDeadline: () => { throw new PaymentError("payment_expired", "validUntil has passed"); },
      mayStillLand: async () => true,
    });
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async () => chainReceipt,
    });
    assert.equal((await scheme.verify(opPayload as never, req())).isValid, true);
    } finally {
      bundler.close();
    }
  }
});

test("an incomplete operation receipt is rechecked without creating a claim", async () => {
  const bundleHash = `0x${"11".repeat(32)}`;
  let queries = 0;
  const bundler = await fakeBundler((method: string) => {
    if (method !== "eth_getUserOperationReceipt") return null;
    return ++queries === 1 ? { success: true } : { success: true, receipt: { transactionHash: bundleHash } };
  });
  try {
    const store = new MemoryStore();
    const scheme = userOpScheme(store, bundler.url);
    Object.assign(scheme, { settleTimeoutMs: 1_000, pollIntervalMs: 10 });
    const result = await scheme.settle(opPayload as never, req());
    assert.equal(result.errorReason, "already_settled");
    assert.equal(result.transaction, bundleHash);
    assert.equal(store.isClaimed(opHash), false);
    assert.equal(store.get(opHash), undefined);
    assert.ok(!bundler.methods.includes("eth_sendUserOperation"));
  } finally {
    bundler.close();
  }
});

test("bundle refreshes retain a delayed result and do not overlap a stalled request", async () => {
  const staleHash = `0x${"11".repeat(32)}`;
  const currentHash = `0x${"22".repeat(32)}`;
  for (const stalled of [false, true]) {
    let queries = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        assert.equal(method, "eth_getUserOperationReceipt");
        const reply = (transactionHash: string) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { receipt: { transactionHash } } }));
        };
        if (++queries === 1) reply(staleHash);
        else if (!stalled) setTimeout(() => reply(currentHash), 100);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new MemoryStore();
      store.claim(opHash);
      const scheme = userOpScheme(store, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      Object.assign(scheme, { settleTimeoutMs: 2_000, pollIntervalMs: 65 });
      let reads = 0;
      Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          reads++;
          if (hash === currentHash || (stalled && reads >= 4)) {
            return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
          }
          return { status: "reverted", logs: [] };
        },
      });
      const result = await scheme.settle(opPayload as never, req());
      assert.equal(result.success, true, stalled ? "confirmation can finish during a stalled refresh" : "consume the delayed hash");
      assert.equal(result.transaction, stalled ? staleHash : currentHash);
      assert.equal(queries, 2, "a pending or unread refresh is reused");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }
});

test("bundle refreshes keep earlier candidates without letting a stalled receipt block a newer one", async () => {
  const firstHash: Hex = `0x${"11".repeat(32)}`;
  const nextHash: Hex = `0x${"22".repeat(32)}`;
  for (const stalled of [false, true]) {
    let lookups = 0;
    const bundler = await fakeBundler((method: string) => {
      assert.equal(method, "eth_getUserOperationReceipt");
      return { receipt: { transactionHash: ++lookups === 1 ? firstHash : nextHash } };
    });
    try {
      const store = new MemoryStore();
      store.claim(opHash);
      const scheme = userOpScheme(store, bundler.url);
      Object.assign(scheme, { settleTimeoutMs: 1_500, pollIntervalMs: 20 });
      const expected = stalled ? nextHash : firstHash;
      let firstReads = 0;
      Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          if (hash === firstHash) {
            firstReads++;
            if (stalled) return new Promise(() => {});
            if (lookups < 2) throw new Error("the first bundle receipt is not yet visible");
          }
          if (hash !== expected) return { status: "reverted", logs: [] };
          return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
        },
      });
      const result = await scheme.settle(opPayload as never, req());
      assert.equal(result.success, true);
      assert.equal(result.transaction, expected);
      assert.ok(lookups >= 2, "a second bundle was reported");
      if (stalled) assert.equal(firstReads, 1, "the pending read is reused");
    } finally {
      bundler.close();
    }
  }
});

test("a bundle reported again stays recent when the candidate cache fills", async () => {
  const hashes = ["11", "22", "33", "44", "11", "55"].map<Hex>((byte) => `0x${byte.repeat(32)}`);
  const [firstHash, evictedHash] = hashes;
  let lookups = 0;
  const bundler = await fakeBundler((method: string) => {
    assert.equal(method, "eth_getUserOperationReceipt");
    return { receipt: { transactionHash: hashes[Math.min(lookups++, hashes.length - 1)] } };
  });
  try {
    const store = new MemoryStore();
    store.claim(opHash);
    const scheme = userOpScheme(store, bundler.url);
    Object.assign(scheme, { settleTimeoutMs: 1_000, pollIntervalMs: 10 });
    const checkedAfterEviction = new Set<Hex>();
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (lookups >= hashes.length) checkedAfterEviction.add(hash);
        if (hash === firstHash && lookups >= hashes.length) {
          return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
        }
        throw new Error("bundle receipt is not visible");
      },
    });
    const result = await scheme.settle(opPayload as never, req());
    assert.equal(result.success, true);
    assert.equal(result.transaction, firstHash);
    assert.ok(!checkedAfterEviction.has(evictedHash), "the least recently reported hash was evicted");
  } finally {
    bundler.close();
  }
});

test("an evicted bundle keeps its pending receipt proof", async () => {
  const hashes = ["11", "22", "33", "44", "55", "11"].map<Hex>((byte) => `0x${byte.repeat(32)}`);
  let lookups = 0;
  const bundler = await fakeBundler((method: string) => {
    assert.equal(method, "eth_getUserOperationReceipt");
    return { receipt: { transactionHash: hashes[Math.min(lookups++, hashes.length - 1)] } };
  });
  try {
    const store = new MemoryStore();
    store.claim(opHash);
    const scheme = userOpScheme(store, bundler.url);
    Object.assign(scheme, { settleTimeoutMs: 1_000, pollIntervalMs: 10 });
    let firstReads = 0;
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (hash !== hashes[0]) throw new Error("receipt not visible");
        if (++firstReads > 1) return new Promise(() => {});
        while (lookups < hashes.length) await new Promise((resolve) => setTimeout(resolve, 1));
        return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
      },
    });
    const result = await scheme.settle(opPayload as never, req());
    assert.equal(result.success, true);
    assert.equal(result.transaction, hashes[0]);
    assert.equal(firstReads, 1, "the original receipt request remains in flight");
  } finally {
    bundler.close();
  }
});

test("a failed candidate cannot overwrite proof received during its receipt wait", async () => {
  const hashes = ["11", "22", "33", "44", "55"].map<Hex>((byte) => `0x${byte.repeat(32)}`);
  let lookups = 0;
  const bundler = await fakeBundler((method: string) => {
    assert.equal(method, "eth_getUserOperationReceipt");
    return { receipt: { transactionHash: hashes[Math.min(lookups++, hashes.length - 1)] } };
  });
  try {
    const store = new MemoryStore();
    store.claim(opHash);
    const scheme = userOpScheme(store, bundler.url);
    Object.assign(scheme, { settleTimeoutMs: 800, pollIntervalMs: 10 });
    let resolveFirst: ((receipt: unknown) => void) | undefined;
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (hash === hashes[0]) return new Promise((resolve) => { resolveFirst = resolve; });
        if (hash === hashes[4]) {
          setTimeout(() => resolveFirst?.({ status: "success", logs: [beforeExecution, transferLog(), operationEvent()] }), 1);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        throw new Error("receipt not visible");
      },
    });
    const result = await scheme.settle(opPayload as never, req());
    assert.equal(result.success, true, result.errorReason);
    assert.equal(result.transaction, hashes[0]);
  } finally {
    bundler.close();
  }
});

test("pending bundle proof survives a long EntryPoint history search", async (t) => {
  const hash: Hex = `0x${"11".repeat(32)}`;
  const store = new MemoryStore();
  if (!("claimForSubmission" in store) || typeof store.claimForSubmission !== "function") {
    t.skip("Requires the submitted-claim history recovery flow");
    return;
  }
  store.claimForSubmission(opHash);
  const bundler = await fakeBundler((method: string) => method === "eth_getUserOperationReceipt"
    ? { receipt: { transactionHash: hash } } : null);
  try {
    const scheme = userOpScheme(store, bundler.url);
    Object.assign(scheme, {
      settleTimeoutMs: 250, pollIntervalMs: 20, nonceUsed: async () => true,
      operationHistory: { find: async () => new Promise((resolve) => setTimeout(() => resolve(undefined), 400)) },
    });
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
      },
    });
    const response = await scheme.settle(opPayload as never, req());
    assert.equal(response.success, true, response.errorReason);
  } finally {
    bundler.close();
  }
});

test("bundle location refreshes during EntryPoint history search", async (t) => {
  const store = new MemoryStore();
  if (!("claimForSubmission" in store) || typeof store.claimForSubmission !== "function") {
    t.skip("Requires the submitted-claim history recovery flow");
    return;
  }
  store.claimForSubmission(opHash);
  const staleHash: Hex = `0x${"11".repeat(32)}`;
  const paidHash: Hex = `0x${"22".repeat(32)}`;
  let lookups = 0;
  const bundler = await fakeBundler((method: string) => method === "eth_getUserOperationReceipt"
    ? { receipt: { transactionHash: ++lookups === 1 ? staleHash : paidHash } } : null);
  try {
    const scheme = userOpScheme(store, bundler.url);
    Object.assign(scheme, {
      settleTimeoutMs: 300, pollIntervalMs: 20, nonceUsed: async () => true,
      operationHistory: { find: async () => new Promise((resolve) => setTimeout(() => resolve(undefined), 450)) },
    });
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => hash === staleHash
        ? { status: "reverted", logs: [] }
        : { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] },
    });
    const response = await scheme.settle(opPayload as never, req());
    assert.equal(response.success, true, response.errorReason);
    assert.equal(response.transaction, paidHash);
    assert.ok(lookups >= 2);
  } finally {
    bundler.close();
  }
});

test("nonce recovery records a replacement when a stale bundle is followed by explicit absence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "x402-stale-bundle-"));
  const path = join(dir, "settled.json");
  let bundler: Awaited<ReturnType<typeof fakeBundler>> | undefined;
  try {
    const store = new FileStore(path);
    if (!("claimForSubmission" in store) || typeof store.claimForSubmission !== "function" ||
        !("nonceUsedPastGrace" in store) || typeof store.nonceUsedPastGrace !== "function") {
      t.skip("Requires the submission claim and EntryPoint history recovery flow");
      return;
    }
    store.claimForSubmission(opHash);
    assert.equal(store.nonceUsedPastGrace(opHash, true, Date.now() - 180_000), false);

    const staleHash: Hex = `0x${"11".repeat(32)}`;
    let lookups = 0;
    bundler = await fakeBundler((method: string) => {
      assert.equal(method, "eth_getUserOperationReceipt");
      return ++lookups === 1 ? { success: false, receipt: { transactionHash: staleHash } } : null;
    });
    const scheme = userOpScheme(store, bundler.url);
    const genesisHash: Hex = `0x${"22".repeat(32)}`;
    const headHash: Hex = `0x${"33".repeat(32)}`;
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    let exactBlockChecked = false;
    Object.assign(scheme, { settleTimeoutMs: 1_000, pollIntervalMs: 10, nonceUsed: async () => true });
    Object.assign((scheme as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        assert.equal(hash, staleHash);
        return { status: "reverted", logs: [] };
      },
      getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => blockNumber === 0n
        ? { number: 0n, hash: genesisHash, parentHash: `0x${"00".repeat(32)}`, timestamp: timestamp - 3_600n }
        : { number: 1n, hash: headHash, parentHash: genesisHash, timestamp },
      readContract: async () => 1n,
      getLogs: async ({ blockHash, args }: { blockHash?: Hex; args: { userOpHash: Hex } }) => {
        assert.equal(args.userOpHash, opHash);
        if (blockHash) {
          assert.equal(blockHash, headHash);
          exactBlockChecked = true;
        }
        return [];
      },
    });

    const response = await scheme.settle(opPayload as never, req());
    assert.equal(response.errorReason, "nonce_used");
    assert.ok(lookups >= 2);
    assert.ok(exactBlockChecked, "the history search proved absence at the canonical block");
    const reloaded = new FileStore(path);
    assert.equal(reloaded.isClaimed(opHash), false);
    assert.equal(reloaded.get(opHash)?.errorReason, "nonce_used");
  } finally {
    bundler?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("user operations: a success is reported only once recorded, and a resend recovers it", async () => {
  const bundler = await fakeBundler({ success: true, receipt: { transactionHash: `0x${"11".repeat(32)}` } });
  try {
    const store = new FlakyStore();
    store.claim(opHash);
    store.failing = true;
    const logged: Record<string, unknown>[] = [];
    const s = userOpScheme(store, bundler.url, logged);
    const first = await s.settle(opPayload as never, req() as never);
    assert.equal(first.errorReason, "settle_unrecorded");
    assert.ok(logged.some((l) => l.event === "store_error"));
    store.failing = false;
    assert.equal((await s.settle(opPayload as never, req() as never)).success, true);
    assert.equal(store.get(opHash)?.success, true);
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "already_settled", "and only once");
  } finally {
    bundler.close();
  }
});

test("a claim that cannot be written answers store_unavailable and submits nothing, in both schemes", async () => {
  const bundler = await fakeBundler(null);
  try {
    const store = new FlakyStore();
    store.failing = true;
    const s = userOpScheme(store, bundler.url);
    Object.assign(s, { chain: { config: { ...MAINNET, bundlerUrl: bundler.url }, client: {} } });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "store_unavailable");
    assert.ok(!store.isClaimed(opHash));
    assert.ok(!bundler.methods.includes("eth_sendUserOperation"), "nothing is submitted");

    const eoaStore = new FlakyStore();
    eoaStore.failing = true;
    const e = new IncentivEoaTxFacilitatorScheme({ store: eoaStore, log: () => {} });
    let sent = false;
    Object.assign(e, {
      chain: { client: { getTransactionReceipt: async () => { throw new Error("not found"); }, sendRawTransaction: async () => { sent = true; } } },
      checkChain: async () => {},
    });
    const d = { txHash: `0x${"ef".repeat(32)}`, sender: merchant, amount: 1n, validUntil: Math.floor(Date.now() / 1000) + 60 };
    const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ errorReason?: string }> }).settleOnce.bind(e);
    assert.equal((await settleOnce(d, req())).errorReason, "store_unavailable");
    assert.ok(!sent, "nothing is submitted");
  } finally {
    bundler.close();
  }
});

test("verify accepts a payment this facilitator submitted and saw succeed, so a verify-first merchant can recover it", async () => {
  // User operations.
  const bundler = await fakeBundler({ success: true, receipt: { transactionHash: `0x${"11".repeat(32)}` } });
  try {
    const store = new MemoryStore();
    const s = userOpScheme(store, bundler.url);
    Object.assign(s, { checkChain: async () => { throw new PaymentError("nonce_used", "account nonce is 1, operation uses 0"); } });
    assert.equal((await s.verify(opPayload as never, req() as never)).invalidReason, "nonce_used", "not claimed here: the chain checks apply");
    store.claim(opHash);
    assert.equal((await s.verify(opPayload as never, req() as never)).isValid, true);
    store.set(opHash, { success: true } as never);
    assert.equal((await s.verify(opPayload as never, req() as never)).invalidReason, "already_settled");
  } finally {
    bundler.close();
  }
  // A claimed operation that reverted is not accepted: the chain checks apply and refuse it.
  const reverted = await fakeBundler({ success: false, reason: "AA23 reverted", receipt: { transactionHash: `0x${"11".repeat(32)}` } });
  try {
    const store = new MemoryStore();
    const s = userOpScheme(store, reverted.url);
    Object.assign((s as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async () => ({ status: "success", logs: [beforeExecution, operationEvent(opHash, false)] }),
    });
    Object.assign(s, { checkChain: async () => { throw new PaymentError("nonce_used", "account nonce is 1, operation uses 0"); } });
    store.claim(opHash);
    assert.equal((await s.verify(opPayload as never, req() as never)).invalidReason, "nonce_used", "a reverted one is not accepted");
  } finally {
    reverted.close();
  }
  // EOA transfers.
  const store = new MemoryStore();
  const e = new IncentivEoaTxFacilitatorScheme({ store, log: () => {} });
  const d = { txHash: `0x${"ef".repeat(32)}`, sender: merchant, ...payment, validUntil: Math.floor(Date.now() / 1000) + 60 };
  let status = "success";
  Object.assign(e, {
    chain: { client: { getTransactionReceipt: async () => ({ ...paidReceipt, status }) } },
    parse: async () => d,
    checkChain: async () => { throw new PaymentError("nonce_used", "account nonce is 1, transaction uses 0"); },
  });
  assert.equal((await e.verify({} as never, req() as never)).invalidReason, "nonce_used");
  store.claim(d.txHash);
  assert.equal((await e.verify({} as never, req() as never)).isValid, true);
  status = "reverted";
  assert.equal((await e.verify({} as never, req() as never)).invalidReason, "nonce_used", "a reverted one is not accepted");
  // After its deadline too: a merchant may recover it late.
  status = "success";
  d.validUntil = Math.floor(Date.now() / 1000) - 60;
  assert.equal((await e.verify({} as never, req() as never)).isValid, true, "recovered after the deadline");
});

test("schemas may not use references, so a pattern cannot hide behind one and a $defs chain cannot explode", () => {
  const c = new Catalog();
  const rec = (url: string, schema: unknown) => {
    const ext = bazaar();
    ext.schema = schema;
    return c.record(payload(url, ext) as never, req());
  };
  const reason = "the discovery schema may not use references";
  assert.equal(rec("https://r.example/1", { type: "object", properties: { a: { $ref: "#/x-hidden" } }, "x-hidden": { type: "string", pattern: "^(a+)+$" } }).rejectedReason, reason);
  assert.equal(rec("https://r.example/2", { properties: { a: { $ref: "#/properties/b/default" }, b: { default: { pattern: "^(a+)+$" } } } }).rejectedReason, reason);
  assert.equal(rec("https://r.example/3", { properties: { a: { $dynamicRef: "#meta" } } }).rejectedReason, reason);
  assert.equal(rec("https://r.example/4", { $ref: "https://evil.example/schema.json" }).rejectedReason, reason);
  assert.equal(rec("https://r.example/5", { properties: { a: { $ref: "#/$defs/s" } }, $defs: { s: { type: "string" } } }).rejectedReason, reason);
  assert.equal(rec("https://r.example/6", { properties: { a: { $id: "#a", type: "string" } } }).rejectedReason, reason);
  // The exponential chain: each $defs entry references the previous one twice.
  const defs: Record<string, unknown> = { d0: { type: "object" } };
  for (let i = 1; i <= 30; i++) defs[`d${i}`] = { allOf: [{ $ref: `#/$defs/d${i - 1}` }, { $ref: `#/$defs/d${i - 1}` }] };
  assert.equal(rec("https://r.example/7", { $defs: defs, properties: { output: { $ref: "#/$defs/d30" } } }).rejectedReason, reason);
  // A property named $ref is a property, not a reference.
  assert.equal(rec("https://r.example/8", { type: "object", properties: { $ref: { type: "string" } } }).status, "success");
});

test("a claim whose success could not be recorded outlives CLAIM_TTL_MS, for RESULT_TTL_MS; a failure is not pinned", () => {
  const store = new FlakyStore();
  store.claim("0xdd");
  store.claim("0xde");
  store.failing = true;
  assert.throws(() => store.set("0xdd", { success: true } as never));
  assert.throws(() => store.set("0xde", { success: false, errorReason: "tx_reverted" } as never));
  assert.ok(store.isClaimed("0xde"), "the failure's claim is kept as it was");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2 * CLAIM_TTL_MS;
    assert.ok(store.isClaimed("0xdd"), "still claimed after the TTL");
    assert.ok(!store.isClaimed("0xde"), "a failure's claim expires as usual");
    store.failing = false;
    store.claim("0xee"); // prunes
    assert.ok(store.isClaimed("0xdd"), "and not pruned");
    Date.now = () => realNow() + RESULT_TTL_MS + 1000;
    assert.ok(!store.isClaimed("0xdd"), "gone once a result would have been forgotten");
    store.claim("0xef"); // prunes
    assert.ok(!(store as unknown as { claims: Map<string, number> }).claims.has("0xdd"), "and pruned");
  } finally {
    Date.now = realNow;
  }
  // A claim an earlier version pinned forever lasts RESULT_TTL_MS from the next start.
  const path = join(mkdtempSync(join(tmpdir(), "x402-pin-")), "settled.json");
  writeFileSync(path, JSON.stringify({ settled: {}, settledAt: {}, claims: { "0xaa": Number.MAX_SAFE_INTEGER } }));
  const loaded = new FileStore(path);
  assert.ok(loaded.isClaimed("0xaa"));
  try {
    Date.now = () => realNow() + RESULT_TTL_MS + 1000;
    assert.ok(!loaded.isClaimed("0xaa"));
  } finally {
    Date.now = realNow;
  }
});

test("an error with a 4xx status from a dependency is a 500 and is logged, not the client's fault", async () => {
  const catalog = new Catalog();
  catalog.list = () => {
    throw Object.assign(new Error("HTTP request failed. Status: 429 URL: https://rpc.example/KEY"), { status: 429 });
  };
  const logged: Record<string, unknown>[] = [];
  const { app } = createFacilitatorApp({ discovery: true, catalog, log: (l) => logged.push(l) });
  const { base, close } = await serve(app);
  try {
    const r = await fetch(`${base}/discovery/resources`);
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "internal_error" });
    assert.ok(logged.some((l) => l.event === "error" && !String(l.error).includes("KEY")));
  } finally {
    await close();
  }
});

test("rate limits count IPv6 clients per /64, and trustProxy: true is refused", () => {
  assert.equal(rateKey("203.0.113.7"), "203.0.113.7");
  assert.equal(rateKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(rateKey("::ffff:102:304"), "1.2.3.4");
  assert.equal(rateKey("::ffff:506:708"), "5.6.7.8");
  assert.equal(rateKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(rateKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
  assert.equal(rateKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(rateKey("::1"), "0:0:0:0::/64");
  assert.equal(rateKey(undefined), "unknown");
  assert.throws(() => createFacilitatorApp({ trustProxy: true as never, log: () => {} }), /forged X-Forwarded-For/);
  assert.doesNotThrow(() => createFacilitatorApp({ trustProxy: 1, log: () => {} }));
});

test("results older than RESULT_TTL_MS are forgotten, and the file keeps their times", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-results-"));
  const path = join(dir, "settled.json");
  const store = new FileStore(path);
  store.set("0xold", { success: true } as never);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + RESULT_TTL_MS / 2;
    store.set("0xnew", { success: true } as never);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { settledAt: Record<string, number> };
    assert.deepEqual(Object.keys(saved.settledAt).sort(), ["0xnew", "0xold"]);
    const reloaded = (new FileStore(path) as unknown as { settledAt: Map<string, number> }).settledAt;
    assert.equal(reloaded.get("0xnew"), saved.settledAt["0xnew"], "a reload keeps each result's time");
    assert.equal(reloaded.get("0xold"), saved.settledAt["0xold"]);
    Date.now = () => realNow() + RESULT_TTL_MS + 1000;
    store.claim("0xother"); // prunes and writes
    assert.equal(store.get("0xold"), undefined);
    assert.ok(store.get("0xnew"));
    assert.equal(new FileStore(path).get("0xold"), undefined, "and the file no longer has it");
  } finally {
    Date.now = realNow;
  }
});

test("failed catalog writes back off, and are logged through the catalog's log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-backoff-"));
  const notADir = join(dir, "file");
  writeFileSync(notADir, "");
  const logged: Record<string, unknown>[] = [];
  const c = new Catalog(join(notADir, "catalog.json"), Date.now, (l) => logged.push(l));
  c.record(payload("https://api.example.com/a") as never, req());
  const write = (c as unknown as { writeInBackground(): Promise<void> }).writeInBackground.bind(c);
  await write();
  await write();
  const delays = logged.filter((l) => l.event === "catalog_save_failed").map((l) => l.retryInMs);
  assert.deepEqual(delays, [4_000, 8_000]);
  clearTimeout((c as unknown as { saveTimer?: NodeJS.Timeout }).saveTimer);
});

test("a revert reason is logged in full and returned cleaned and capped", () => {
  const logged: Record<string, unknown>[] = [];
  const s = new IncentivUserOpFacilitatorScheme({ log: (l) => logged.push(l) });
  const reason = "AA23 reverted: " + "x".repeat(1_500) + "\nsee https://rpc.example/KEY";
  const out = (s as unknown as { revertReason(h: string, r: string): string }).revertReason("0xabc", reason);
  assert.equal(out.length, 1_000);
  assert.ok(!out.includes("\n"));
  const line = logged.find((l) => l.event === "userop_reverted")!;
  assert.ok(String(line.reason).includes("x".repeat(1_500)) && String(line.reason).includes("https://rpc.example/…"));
  assert.ok(!String(line.reason).includes("KEY"));
});

// Windows has no catchable SIGTERM: child.kill() ends the process at once there.
test("shutdown: a repeated SIGTERM is ignored while a request is open, and a second SIGINT forces the stop", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-signals-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/facilitator/main.ts"], {
    env: { ...process.env, PORT: String(port), FACILITATOR_DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop()!;
    for (const l of parts) if (l.trim()) lines.push(JSON.parse(l) as Record<string, unknown>);
  });
  const waitFor = async (event: string) => {
    for (let i = 0; i < 200 && !lines.some((l) => l.event === event); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(lines.some((l) => l.event === event), `no ${event} line: ${JSON.stringify(lines)}`);
  };
  const exited = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
  try {
    await waitFor("listening");
    // A request that is still being sent keeps the server from closing, like a settle in flight.
    const { connect } = await import("node:net");
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {}); // the forced stop resets the connection
    await new Promise<void>((ok) => socket.on("connect", () => ok()));
    socket.write("POST /settle HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{");
    await new Promise((r) => setTimeout(r, 200));
    child.kill("SIGTERM");
    await waitFor("shutdown");
    child.kill("SIGTERM");
    await waitFor("shutdown_in_progress");
    assert.equal(child.exitCode, null, "still running after a repeated SIGTERM");
    child.kill("SIGINT");
    assert.equal(await exited, 1);
    assert.ok(lines.some((l) => l.event === "shutdown_forced"));
    socket.destroy();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a payer cannot overwrite a merchant's listing for less than the route recently earned", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0;
  const dir = mkdtempSync(join(tmpdir(), "x402-versions-"));
  const path = join(dir, "catalog.json");
  const c = new Catalog(path, () => clock);
  const url = "https://api.merchant.example/weather";
  const pay = (description: string, amount: string, who: string) => {
    const p = payload(url) as unknown as { resource: { description: string } };
    p.resource.description = description;
    return c.record(p as never, { ...req(), amount } as never, new Date(clock), who);
  };
  const shown = () => c.list({}).items[0]!;
  for (let i = 0; i < 3; i++) pay("Real weather", "10", addr(100 + i));
  // A 1-unit payment with other details is refused, and the listing keeps the merchant's details and price.
  const attack = pay("Evil weather", "1", addr(1));
  assert.equal(attack.rejectedReason, "another version of this listing has more recent payments");
  assert.equal(shown().description, "Real weather");
  assert.equal(shown().accepts[0]!.amount, "10");
  // A self-payment adds nothing, so the merchant's address cannot swap it either.
  assert.equal(pay("Evil weather", "1000", merchant).status, "rejected");
  // The restart keeps the served version's score.
  c.flush();
  const reloaded = new Catalog(path, () => clock);
  const p = payload(url) as unknown as { resource: { description: string } };
  p.resource.description = "Evil weather";
  assert.equal(reloaded.record(p as never, { ...req(), amount: "5" } as never, new Date(clock), addr(2)).status, "rejected");
  assert.equal(reloaded.list({}).items[0]!.description, "Real weather");
  // Outpaying the route's recent revenue (30 units) does replace it, and that money went to the merchant: the
  // attacker's version (the listed price is part of it) has 1 unit, so 30 more payments make 31.
  const results = Array.from({ length: 30 }, () => pay("Evil weather", "1", addr(1)).status);
  assert.equal(results.indexOf("success"), 29);
  assert.equal(shown().description, "Evil weather");
});

test("a merchant's new declaration takes over as its customers pay for it", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0;
  const c = new Catalog(undefined, () => clock);
  const url = "https://api.merchant.example/weather";
  const pay = (description: string, amount: string, who: string) => {
    const p = payload(url) as unknown as { resource: { description: string } };
    p.resource.description = description;
    return c.record(p as never, { ...req(), amount } as never, new Date(clock), who);
  };
  for (let i = 0; i < 10; i++) pay("Old text", "10", addr(100 + i));
  // Three days later the old version's 100 units count as 12.5 (above its floor of one 10-unit sale).
  clock = t0 + 3 * CATALOG_LIMITS.versionHalfLifeMs;
  for (let i = 0; i < 3; i++) assert.equal(pay("New text", "4", addr(101 + i)).status, "rejected", "12 units do not beat 12.5");
  assert.equal(pay("New text", "4", addr(104)).status, "success");
  assert.equal(c.list({}).items[0]!.description, "New text");
});

test("on a dynamic route every sale is the same version, so the score adds up", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const c = new Catalog(undefined, () => t0);
  const url = "https://api.merchant.example/items/:itemId";
  const sale = (itemId: string, description: string, amount: string, who: string) => {
    const ext = bazaar();
    (ext.info as { input: Record<string, unknown> }).input.pathParams = { itemId };
    const p = payload(url, ext) as unknown as { resource: { description: string } };
    p.resource.description = description;
    return c.record(p as never, { ...req(), amount } as never, new Date(t0), who);
  };
  for (let i = 0; i < 10; i++) assert.equal(sale(`id-${i}`, "Items", "1000000", addr(100 + i)).status, "success");
  // One payment just above a single sale does not replace a route that earned ten.
  assert.equal(sale("x", "Evil items", "1000001", addr(1)).status, "rejected");
  assert.equal(c.list({}).items[0]!.description, "Items");
});

test("a listing stored before versions were scored counts as at least one sale at its listed price", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-floor-"));
  const path = join(dir, "catalog.json");
  const now = Date.parse("2026-11-19T00:00:00Z");
  const r = "https://api.example.com/premium";
  // The format written by the base branch: no payers, paid or score.
  writeFileSync(path, JSON.stringify({ [`GET ${r} eip155:24101 ${merchant.toLowerCase()}`]: { resource: r, type: "http", x402Version: 2, accepts: [{ ...req(), amount: "1000000" }], lastUpdated: new Date(now).toISOString(), description: "Premium forecast", extensions: { bazaar: bazaar() } } }));
  const c = new Catalog(path, () => now);
  const p = payload(r) as unknown as { resource: { description: string } };
  p.resource.description = "Evil";
  assert.equal(c.record(p as never, req() as never, new Date(now), addr(1)).status, "rejected", "a 1-unit payment does not replace it");
  assert.equal(c.list({}).items[0]!.description, "Premium forecast");
});

test("a high listed price does not hold a listing once it stops selling: the floor decays like any score", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0;
  const c = new Catalog(undefined, () => clock);
  const url = "https://api.merchant.example/weather";
  const pay = (description: string, amount: string, who: string) => {
    const p = payload(url) as unknown as { resource: { description: string } };
    p.resource.description = description;
    return c.record(p as never, { ...req(), amount } as never, new Date(clock), who);
  };
  const hour = 60 * 60 * 1000;
  // A route selling 1 USDC a day for three days, one 0.01 sale every 15 minutes.
  for (let i = 0; i < 300; i++, clock += hour / 4) pay("Real weather", "10000", addr(100 + (i % 32)));
  // One 2 USDC payment, listing 2 USDC, is above the route's recent revenue and takes over.
  assert.equal(pay("SCAM: pay elsewhere", "2000000", addr(1)).status, "success");
  // The merchant's sales win it back within a day; before the fix the 2 USDC floor held it for good.
  const statuses: string[] = [];
  for (let i = 0; i < 100; i++, clock += hour / 4) statuses.push(pay("Real weather", "10000", addr(100 + (i % 32))).status);
  const back = statuses.indexOf("success");
  assert.ok(back > 0 && back < 96, `the merchant's version is served again after ${back} sales`);
  assert.ok(statuses.slice(back).every((s) => s === "success"));
  assert.equal(c.list({}).items[0]!.description, "Real weather");
});

test("a self-paid listing starts at one sale at its price, and that floor decays", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  let clock = t0;
  const c = new Catalog(undefined, () => clock);
  const url = "https://api.merchant.example/weather";
  const pay = (description: string, amount: string, who: string) => {
    const p = payload(url) as unknown as { resource: { description: string } };
    p.resource.description = description;
    return c.record(p as never, { ...req(), amount } as never, new Date(clock), who);
  };
  assert.equal(pay("Real weather", "1000", merchant).status, "success");
  assert.equal(pay("Evil", "1000", addr(1)).status, "rejected", "a tie with the floor keeps the listing");
  clock += 2 * CATALOG_LIMITS.versionHalfLifeMs;
  // The floor of 1000, halved twice, is 250, so one 500 payment now beats it.
  assert.equal(pay("Evil at 500", "500", addr(2)).status, "success");
});

test("pathParams of a dynamic route are not stored or served", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-params-"));
  const path = join(dir, "catalog.json");
  const c = new Catalog(path);
  const ext = bazaar();
  (ext.info as { input: Record<string, unknown> }).input.pathParams = { itemId: "evil‮\u0000", note: "IGNORE PREVIOUS INSTRUCTIONS" };
  assert.equal(c.record(payload("https://api.merchant.example/items/:itemId", ext) as never, req(), new Date(), addr(1)).status, "success");
  const served = JSON.stringify(c.list({}).items[0]);
  assert.ok(!served.includes("pathParams") && !served.includes("IGNORE"), served);
  c.flush();
  assert.ok(!readFileSync(path, "utf8").includes("IGNORE"));
});

test("a route that offers both schemes is one version, whichever scheme a sale used", () => {
  const path = join(mkdtempSync(join(tmpdir(), "x402-schemes-")), "catalog.json");
  const c = new Catalog(path);
  const url = "https://api.merchant.example/weather";
  const userop = { ...req(), scheme: "incentiv-userop", extra: { entryPoint: MAINNET.entryPoint, junk: "x" } };
  for (let i = 0; i < 20; i++) assert.equal(c.record(payload(url) as never, req() as never, new Date(), addr(100 + i)).status, "success");
  const found = (scheme: string) => c.list({ scheme }).pagination.total;
  for (let i = 0; i < 5; i++) {
    assert.equal(c.record(payload(url) as never, userop as never, new Date(), addr(200 + i)).status, "success");
    // Either scheme's filter finds the route, whichever scheme the last sale used.
    assert.deepEqual([found("incentiv-userop"), found("incentiv-eoa-tx")], [1, 1]);
    assert.equal(c.record(payload(url) as never, req() as never, new Date(), addr(300 + i)).status, "success");
    assert.deepEqual([found("incentiv-userop"), found("incentiv-eoa-tx")], [1, 1]);
  }
  assert.equal(c.list({}).pagination.total, 1);
  // One item per scheme, the latest sale's first, each with only the extra its scheme defines.
  const accepts = c.list({}).items[0]!.accepts;
  assert.deepEqual(accepts.map((a) => a.scheme), ["incentiv-eoa-tx", "incentiv-userop"]);
  assert.equal(accepts[0]!.extra, undefined);
  assert.deepEqual(accepts[1]!.extra, { entryPoint: MAINNET.entryPoint });
  // Both ways to pay survive a restart.
  c.flush();
  assert.deepEqual(new Catalog(path).list({}).items[0]!.accepts.map((a) => a.scheme), ["incentiv-eoa-tx", "incentiv-userop"]);
  // The list stays bounded whatever schemes are recorded.
  c.record(payload(url) as never, { ...req(), scheme: "other" } as never, new Date(), addr(400));
  assert.equal(c.list({}).items[0]!.accepts.length, CATALOG_LIMITS.maxAccepts);
});

test("each scheme on a listing keeps its own timeout, a repeat sale does not push the other out, and one unused for staleMs drops", () => {
  const t0 = Date.parse("2026-11-20T00:00:00Z");
  let clock = t0;
  const path = join(mkdtempSync(join(tmpdir(), "x402-schemes-")), "catalog.json");
  let c = new Catalog(path, () => clock);
  const url = "https://api.merchant.example/weather";
  const eoa = { ...req(), maxTimeoutSeconds: 60 };
  const userop = { ...req(), scheme: "incentiv-userop", maxTimeoutSeconds: 120, extra: { entryPoint: MAINNET.entryPoint } };
  const sale = (r: unknown, i: number) => c.record(payload(url) as never, r as never, new Date(clock), addr(100 + i)).status;
  const schemes = () => c.list({}).items[0]!.accepts.map((a) => `${a.scheme}:${a.maxTimeoutSeconds}`);
  // Different timeouts per scheme are one version: every sale is listed.
  for (let i = 0; i < 10; i++) {
    assert.equal(sale(eoa, i), "success");
    assert.equal(sale(userop, i), "success");
  }
  assert.deepEqual(schemes(), ["incentiv-userop:120", "incentiv-eoa-tx:60"]);
  // Two sales in a row with one scheme keep the other.
  sale(eoa, 20);
  sale(eoa, 21);
  assert.deepEqual(schemes(), ["incentiv-eoa-tx:60", "incentiv-userop:120"]);
  // User operations are not used for a while; the time of their last sale survives a restart.
  clock += CATALOG_LIMITS.staleMs - 1_000;
  sale(eoa, 22);
  c.flush();
  c = new Catalog(path, () => clock);
  assert.deepEqual(schemes(), ["incentiv-eoa-tx:60", "incentiv-userop:120"], "still within staleMs");
  clock += 2_000;
  sale(eoa, 23);
  assert.deepEqual(schemes(), ["incentiv-eoa-tx:60"], "not paid for staleMs: dropped");
  assert.equal(c.list({ scheme: "incentiv-userop" }).pagination.total, 0);
  // A new user-operation sale lists it again.
  sale(userop, 24);
  assert.deepEqual(schemes(), ["incentiv-userop:120", "incentiv-eoa-tx:60"]);
});

test("EOA: a lost submission response keeps the claim, and the retry reports the receipt once", async () => {
  const store = new MemoryStore();
  const logged: Record<string, unknown>[] = [];
  const e = new IncentivEoaTxFacilitatorScheme({ store, log: (l) => logged.push(l), settleTimeoutMs: 50, pollIntervalMs: 5 });
  let receipt: { status: string } | undefined;
  let sendError: unknown;
  let count = 0;
  const tags: unknown[] = [];
  Object.assign(e, {
    chain: { client: {
      getTransactionReceipt: async () => { if (!receipt) throw new Error("not found"); return receipt; },
      getTransactionCount: async (a: { blockTag?: unknown }) => { tags.push(a.blockTag); return count; },
      sendRawTransaction: async () => { throw sendError; },
    } },
    checkChain: async () => {},
  });
  const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ success: boolean; errorReason?: string }> }).settleOnce.bind(e);
  const tx = (n: number) => ({ txHash: `0x${n.toString(16).padStart(64, "0")}`, sender: merchant, ...payment, nonce: 0, validUntil: Math.floor(Date.now() / 1000) + 60 });
  const rpcError = (code: number, message: string) => new RpcRequestError({ body: {}, error: { code, message }, url: "http://rpc.example" });

  // The node took the transaction but the reply was lost.
  const d = tx(1);
  sendError = new TypeError("fetch failed");
  assert.equal((await settleOnce(d, req())).errorReason, "settle_timeout");
  assert.ok(store.isClaimed(d.txHash), "the claim is kept");
  assert.ok(logged.some((l) => l.event === "submit_unknown"));
  receipt = paidReceipt;
  assert.equal((await settleOnce(d, req())).success, true, "the retry reconciles the same hash");
  receipt = undefined;

  // An internal error and a 5xx status are not answers either.
  const internal = tx(2);
  sendError = rpcError(-32603, "internal error");
  assert.equal((await settleOnce(internal, req())).errorReason, "settle_timeout");
  assert.ok(store.isClaimed(internal.txHash));
  const gateway = tx(20);
  sendError = new HttpRequestError({ url: "http://rpc.example", status: 502, details: "Bad Gateway" });
  assert.equal((await settleOnce(gateway, req())).errorReason, "settle_timeout");
  assert.ok(store.isClaimed(gateway.txHash));

  // A refusal with the nonce unused is definite: the claim is released and the payment can be sent again.
  const refused = tx(3);
  sendError = rpcError(-32000, "insufficient funds for gas");
  assert.equal((await settleOnce(refused, req())).errorReason, "tx_rejected");
  assert.ok(!store.isClaimed(refused.txHash));
  // So is a 4xx status.
  const badRequest = tx(30);
  sendError = new HttpRequestError({ url: "http://rpc.example", status: 400, details: '{"code":-32000,"message":"invalid sender"}' });
  assert.equal((await settleOnce(badRequest, req())).errorReason, "tx_rejected");
  assert.ok(!store.isClaimed(badRequest.txHash));
  assert.ok(tags.length > 0 && tags.every((t) => t === "pending"), "the nonce check counts the node's mempool");

  // What viem retries can follow an attempt the node accepted (a timeout, then a 429): not a refusal.
  for (const [i, err] of [
    new HttpRequestError({ url: "http://rpc.example", status: 429, details: "Too Many Requests" }),
    new HttpRequestError({ url: "http://rpc.example", status: 403, details: "Forbidden" }),
    rpcError(-32005, "limit exceeded"),
  ].entries()) {
    const retried = tx(40 + i);
    sendError = err;
    assert.equal((await settleOnce(retried, req())).errorReason, "settle_timeout", String(err));
    assert.ok(store.isClaimed(retried.txHash), "the claim is kept");
  }

  // A refusal while the transaction waits in the node's mempool (pending nonce moved on): the claim is kept.
  const pending = tx(50);
  count = 1;
  sendError = rpcError(-32000, "nonce too low");
  assert.equal((await settleOnce(pending, req())).errorReason, "settle_timeout");
  assert.ok(store.isClaimed(pending.txHash));
  count = 0;

  // A resend refused with "nonce too low" because the first send landed: the receipt is reported, once.
  const landed = tx(4);
  sendError = rpcError(-32000, "nonce too low");
  receipt = paidReceipt;
  let submitted = false;
  Object.assign((e as unknown as { chain: { client: object } }).chain.client, {
    // No receipt before the submission; the refused resend finds it.
    getTransactionReceipt: async () => { if (!submitted) throw new Error("not found"); return receipt; },
    sendRawTransaction: async () => { submitted = true; throw sendError; },
  });
  assert.equal((await settleOnce(landed, req())).success, true);
  assert.equal(store.get(landed.txHash)?.success, true, "recorded, so a later settle answers already_settled");
  Object.assign((e as unknown as { chain: { client: object } }).chain.client, { sendRawTransaction: async () => { throw sendError; } });

  // "nonce too low" with no receipt yet, but the nonce used: the claim is kept and the receipt decides.
  receipt = undefined;
  Object.assign((e as unknown as { chain: { client: object } }).chain.client, { getTransactionReceipt: async () => { if (!receipt) throw new Error("not found"); return receipt; } });
  const lagging = tx(5);
  count = 1;
  assert.equal((await settleOnce(lagging, req())).errorReason, "settle_timeout", "retryable: the claim is held");
  assert.ok(store.isClaimed(lagging.txHash), "the claim is kept");
  receipt = paidReceipt;
  assert.equal((await settleOnce(lagging, req())).success, true, "and a retry reports it once it is visible");
});

test("a retry of a claimed payment whose nonce is used waits for its receipt instead of failing, in both schemes", async () => {
  // EOA transfers.
  const store = new MemoryStore();
  // Successes get a window far longer than they need; only the settle_timeout cases use a short one.
  const e = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, settleTimeoutMs: 10_000, pollIntervalMs: 5 });
  let lookups = 0;
  let expired = false;
  let resent = false;
  Object.assign(e, {
    chain: { client: {
      // Visible only from the fourth lookup on: the retry's first lookup misses it.
      getTransactionReceipt: async () => { if (++lookups < 4) throw new Error("not found"); return paidReceipt; },
      getTransactionCount: async () => 1,
      sendRawTransaction: async () => { resent = true; },
    } },
    checkDeadline: () => { if (expired) throw new PaymentError("payment_expired", "validUntil has passed"); },
    checkChain: async () => { throw new PaymentError("nonce_used", "account nonce is 1, transaction uses 0"); },
  });
  const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ success: boolean; errorReason?: string }> }).settleOnce.bind(e);
  const d = { txHash: `0x${"a1".repeat(32)}`, sender: merchant, ...payment, nonce: 0 };
  assert.equal((await settleOnce(d, req())).errorReason, "nonce_used", "not claimed here: refused at once");
  assert.equal(lookups, 1);
  lookups = 0;
  store.claim(d.txHash);
  assert.equal((await settleOnce(d, req())).success, true);
  // Past its deadline too, as long as the nonce is used.
  const late = { ...d, txHash: `0x${"a2".repeat(32)}` };
  store.claim(late.txHash);
  lookups = 0;
  expired = true;
  assert.equal((await settleOnce(late, req())).success, true);
  assert.ok(!resent, "a claimed payment whose nonce is used is never submitted again");
  // No receipt at all: settle_timeout after the settle window, since a retry can still find it.
  Object.assign((e as unknown as { chain: { client: object } }).chain.client, { getTransactionReceipt: async () => { throw new Error("not found"); } });
  const never = { ...d, txHash: `0x${"a3".repeat(32)}` };
  store.claim(never.txHash);
  expired = false;
  Object.assign(e, { settleTimeoutMs: 200 });
  assert.equal((await settleOnce(never, req())).errorReason, "settle_timeout");
  assert.ok(store.isClaimed(never.txHash));
  // Expired with the nonce unused: it never landed, so the answer is immediate.
  Object.assign((e as unknown as { chain: { client: object } }).chain.client, { getTransactionCount: async () => 0 });
  expired = true;
  Object.assign(e, { settleTimeoutMs: 10_000 });
  const started = Date.now();
  assert.equal((await settleOnce(never, req())).errorReason, "payment_expired");
  assert.ok(Date.now() - started < 5_000, "answered without waiting for the window");
  // Expired, and the RPC cannot say whether the nonce is used: it may still be pending, so the claim waits.
  Object.assign((e as unknown as { chain: { client: object } }).chain.client, { getTransactionCount: async () => { throw new Error("rpc down"); } });
  Object.assign(e, { settleTimeoutMs: 200 });
  assert.equal((await settleOnce(never, req())).errorReason, "settle_timeout", "not the final payment_expired");
  assert.ok(store.isClaimed(never.txHash));

  // User operations.
  let opLookups = 0;
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: ++opLookups < 4 ? null : { success: true, receipt: { transactionHash: `0x${"11".repeat(32)}` } } }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const opStore = new MemoryStore();
    const s = userOpScheme(opStore, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    Object.assign(s, { settleTimeoutMs: 10_000, pollIntervalMs: 5, checkChain: async () => { throw new PaymentError("nonce_used", "account nonce is 1, operation uses 0"); } });
    opStore.claim(opHash);
    assert.equal((await s.settle(opPayload as never, req() as never)).success, true);
  } finally {
    server.close();
  }
});

test("a submission that never answers ends within the settle window, with the claim kept", async () => {
  const store = new MemoryStore();
  const e = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, settleTimeoutMs: 100, pollIntervalMs: 5 });
  Object.assign(e, {
    chain: { client: { getTransactionReceipt: async () => { throw new Error("not found"); }, sendRawTransaction: () => new Promise(() => {}) } },
    checkChain: async () => {},
  });
  const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ success: boolean; errorReason?: string }> }).settleOnce.bind(e);
  const d = { txHash: `0x${"b1".repeat(32)}`, sender: merchant, amount: 1n, nonce: 0, validUntil: Math.floor(Date.now() / 1000) + 60 };
  const started = Date.now();
  assert.equal((await settleOnce(d, req())).errorReason, "settle_timeout");
  assert.ok(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
  assert.ok(store.isClaimed(d.txHash));

  // A bundler that hangs.
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      if (method === "eth_sendUserOperation") return; // never answers
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const opStore = new MemoryStore();
    const s = userOpScheme(opStore, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    Object.assign(s, { settleTimeoutMs: 100, pollIntervalMs: 5 });
    const t = Date.now();
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(Date.now() - t < 2_500, `took ${Date.now() - t} ms`);
    assert.ok(opStore.isClaimed(opHash));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("user operations: a lost submission response keeps the claim, and the retry reports the receipt once", async () => {
  let mode: "drop" | "refuse" | "refuse400" | "http400" | "http502" | "json502" | "json408" | "stringCode" = "drop";
  let receipt: unknown = null;
  let locateAfterRefusal = false;
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      if (method === "eth_sendUserOperation" && mode === "drop") return void res.socket?.destroy();
      res.setHeader("content-type", "application/json");
      if (method === "eth_sendUserOperation") {
        if (locateAfterRefusal) receipt = { success: true, receipt: { transactionHash: `0x${"11".repeat(32)}` } };
        const refusal = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32500, message: "AA21 didn't pay prefund" } });
        if (mode === "refuse") return void res.end(refusal);
        if (mode === "refuse400") return void res.writeHead(400).end(refusal);
        if (mode === "http400") return void res.writeHead(400).end("Bad Request");
        if (mode === "json408") return void res.writeHead(408).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "upstream timed out" } }));
        if (mode === "json502") return void res.writeHead(502).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "upstream bundler unavailable" } }));
        if (mode === "stringCode") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: "-32500", message: "AA21 didn't pay prefund" } }));
        return void res.writeHead(502).end("Bad Gateway");
      }
      if (method === "eth_getUserOperationByHash" && locateAfterRefusal) {
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: receipt }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const store = new MemoryStore();
    const logged: Record<string, unknown>[] = [];
    const s = userOpScheme(store, url, logged);
    Object.assign(s, { settleTimeoutMs: 50, pollIntervalMs: 5 });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(store.isClaimed(opHash), "the claim is kept");
    assert.ok(logged.some((l) => l.event === "submit_unknown"));
    receipt = { success: true, receipt: { transactionHash: `0x${"11".repeat(32)}` } };
    Object.assign(s, { settleTimeoutMs: 10_000 });
    assert.equal((await s.settle(opPayload as never, req() as never)).success, true, "the retry reconciles the same hash");
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "already_settled", "and only once");

    // A bundler's refusal is definite, whether it comes with status 200 or 4xx: the claim is released at once.
    receipt = null;
    for (const m of ["refuse", "refuse400", "http400", "stringCode"] as const) {
      const other = new MemoryStore();
      const refusing = userOpScheme(other, url);
      Object.assign(refusing, { settleTimeoutMs: 5_000 });
      mode = m;
      const started = Date.now();
      const r = await refusing.settle(opPayload as never, req() as never);
      assert.equal(r.errorReason, "userop_rejected", m);
      assert.ok(Date.now() - started < 2_500, `${m}: answered at once`);
      if (m !== "http400") assert.match(r.errorMessage ?? "", /AA21/, "the bundler's reason reaches the merchant");
      assert.ok(!other.isClaimed(opHash));
    }
    const located = new MemoryStore();
    located.claim(opHash);
    const recovering = userOpScheme(located, url);
    let chainReads = 0;
    Object.assign(recovering, { settleTimeoutMs: 1_000, pollIntervalMs: 10 });
    Object.assign((recovering as unknown as { chain: { client: object } }).chain.client, {
      getTransactionReceipt: async () => {
        if (++chainReads < 3) throw new Error("chain receipt is not visible yet");
        return { status: "success", logs: [beforeExecution, transferLog(), operationEvent()] };
      },
    });
    mode = "refuse";
    locateAfterRefusal = true;
    assert.equal((await recovering.settle(opPayload as never, req())).success, true);
    assert.equal(chainReads, 3);
    locateAfterRefusal = false;
    receipt = null;

    // A 5xx status is not an answer.
    const gateway = new MemoryStore();
    const g = userOpScheme(gateway, url);
    Object.assign(g, { settleTimeoutMs: 50, pollIntervalMs: 5 });
    mode = "http502";
    assert.equal((await g.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(gateway.isClaimed(opHash));
    // A 5xx with a JSON-RPC error body is still not an answer: a proxy may have sent it after the bundler took it.
    const proxied = new MemoryStore();
    const px = userOpScheme(proxied, url);
    Object.assign(px, { settleTimeoutMs: 50, pollIntervalMs: 5 });
    mode = "json502";
    assert.equal((await px.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(proxied.isClaimed(opHash));
    // So is a 408 with a JSON-RPC error body: the request timed out upstream and may have been taken.
    const timedOut = new MemoryStore();
    const to = userOpScheme(timedOut, url);
    Object.assign(to, { settleTimeoutMs: 50, pollIntervalMs: 5 });
    mode = "json408";
    assert.equal((await to.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(timedOut.isClaimed(opHash));

    // A refusal while the nonce is used keeps the claim: the operation may have landed.
    const used = new MemoryStore();
    const u = userOpScheme(used, url);
    Object.assign(u, { settleTimeoutMs: 50, pollIntervalMs: 5, nonceUsed: async () => true });
    mode = "refuse";
    assert.equal((await u.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(used.isClaimed(opHash));
  } finally {
    server.close();
  }
});

test("equivalent declarations are one version: key order and address casing do not split a listing", () => {
  const c = new Catalog();
  const url = "https://api.merchant.example/weather";
  const userop = { ...req(), scheme: "incentiv-userop", payTo: merchant.toLowerCase(), asset: MAINNET.usdc.toLowerCase(), extra: { entryPoint: MAINNET.entryPoint } };
  for (let i = 0; i < 5; i++) assert.equal(c.record(payload(url) as never, req() as never, new Date(), addr(100 + i)).status, "success");
  // The same declaration with its keys in another order, paid with the other scheme and a lowercased address.
  const reordered = Object.fromEntries(Object.entries(bazaar()).reverse());
  reordered.info = Object.fromEntries(Object.entries(reordered.info as Record<string, unknown>).reverse());
  assert.equal(c.record(payload(url, reordered) as never, userop as never, new Date(), addr(200)).status, "success");
  assert.equal(c.list({ scheme: "incentiv-userop" }).pagination.total, 1);
  assert.equal(c.list({ scheme: "incentiv-eoa-tx" }).pagination.total, 1);
  assert.equal(c.list({}).items[0]!.accepts.length, 2);
});

test("a malformed bundler error is still an error: a simulation answered with one fails", async () => {
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: "-32500", message: "AA23 reverted" } }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const chain = { config: { ...MAINNET, bundlerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, client: {} };
    await assert.rejects(bundlerRpc(chain as never, "eth_estimateUserOperationGas", []), (e: unknown) => e instanceof BundlerRpcError && /AA23/.test(e.message));
  } finally {
    server.close();
  }
});

test("settle checks that do not finish within the window answer settle_timeout and submit nothing; unexpected errors are settle errors", async () => {
  const store = new MemoryStore();
  const logged: Record<string, unknown>[] = [];
  const e = new IncentivEoaTxFacilitatorScheme({ store, log: (l) => logged.push(l), settleTimeoutMs: 100, pollIntervalMs: 5 });
  let sent = false;
  let checks: () => Promise<void> = () => new Promise(() => {});
  Object.assign(e, {
    chain: { client: { getTransactionReceipt: async () => { throw new Error("not found"); }, sendRawTransaction: async () => { sent = true; } } },
    checkChain: () => checks(),
  });
  const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ success: boolean; errorReason?: string }> }).settleOnce.bind(e);
  const d = { txHash: `0x${"c1".repeat(32)}`, sender: merchant, amount: 1n, nonce: 0, validUntil: Math.floor(Date.now() / 1000) + 60 };
  const started = Date.now();
  assert.equal((await settleOnce(d, req())).errorReason, "settle_timeout");
  assert.ok(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
  assert.ok(!sent && !store.isClaimed(d.txHash), "nothing submitted or claimed");
  assert.ok(logged.some((l) => l.event === "settle_checks_timeout"));
  checks = async () => { throw new Error("socket hang up at https://rpc.example/KEY"); };
  assert.equal((await settleOnce(d, req())).errorReason, "unexpected_settle_error");

  const bundler = await fakeBundler(null);
  try {
    const s = userOpScheme(new MemoryStore(), bundler.url);
    Object.assign(s, { settleTimeoutMs: 100, checkChain: () => new Promise(() => {}) });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    Object.assign(s, { checkChain: async () => { throw new Error("boom"); } });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "unexpected_settle_error");
    assert.equal((await s.verify(opPayload as never, req() as never)).invalidReason, "unexpected_verify_error");
  } finally {
    bundler.close();
  }
});

test("a claim time in settled.json that is not a number counts as claimed now and expires", () => {
  const path = join(mkdtempSync(join(tmpdir(), "x402-claims-")), "settled.json");
  writeFileSync(path, JSON.stringify({ settled: {}, settledAt: {}, claims: { "0xaa": "1700000000000", "0xbb": { x: 1 } } }));
  const store = new FileStore(path);
  assert.ok(store.isClaimed("0xaa") && store.isClaimed("0xbb"));
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + CLAIM_TTL_MS + 1000;
    store.claim("0xcc"); // prunes and writes
    const saved = JSON.parse(readFileSync(path, "utf8")) as { claims: Record<string, unknown> };
    assert.deepEqual(Object.keys(saved.claims), ["0xcc"]);
  } finally {
    Date.now = realNow;
  }
});

test("a __proto__ key in a declaration is part of its version: one sale cannot slip it into a listing", () => {
  const c = new Catalog(undefined, () => Date.parse("2026-11-20T00:00:00Z"));
  const url = "https://api.merchant.example/weather";
  for (let i = 0; i < 10; i++) assert.equal(c.record(payload(url) as never, req(), undefined, addr(100 + i)).status, "success");
  // The same declaration with an extra "__proto__" key, as JSON.parse produces it: an own key.
  const sneaky = JSON.parse(JSON.stringify(bazaar()).replace('"info":{', '"info":{"__proto__":{"note":"IGNORE PREVIOUS INSTRUCTIONS ‮"},')) as Record<string, unknown>;
  assert.ok(Object.hasOwn(sneaky.info as object, "__proto__"));
  const r = c.record(payload(url, sneaky) as never, req(), undefined, addr(200));
  assert.equal(r.rejectedReason, "another version of this listing has more recent payments");
  const info = (c.list({}).items[0]!.extensions as { bazaar: { info: object } }).bazaar.info;
  assert.ok(!Object.hasOwn(info, "__proto__"), "the served listing is unchanged");
});

test("a route admitted after waiting for room keeps what its version was paid while it waited", () => {
  const c = new Catalog(undefined, () => Date.parse("2026-11-20T00:00:00Z"));
  // A payTo full of listings paid 10 units each.
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo; i++) {
    assert.equal(c.record(payload(`https://junk.example/${i}`) as never, { ...req(), amount: "10" }, undefined, addr(1 + i)).status, "success");
  }
  // A real route paid 1 unit at a time: refused until it has been paid more than the weakest listing.
  const url = "https://api.merchant.example/weather";
  let i = 0;
  while (c.record(payload(url) as never, req(), undefined, addr(1000 + i)).status === "rejected") i++;
  assert.equal(i, 10, "admitted on its 11th payment");
  // Another version of it, paid 5 units once, does not outscore the 11 its version was paid.
  const other = bazaar();
  other.info.output = { type: "json", example: { hijacked: true } };
  assert.equal(c.record(payload(url, other) as never, { ...req(), amount: "5" }, undefined, addr(2000)).rejectedReason, "another version of this listing has more recent payments");
});

test("a refusal is recognized through viem's own error wrapping", async () => {
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      if (method === "eth_sendRawTransaction") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "insufficient funds for gas * price + value" } }));
      if (method === "eth_getTransactionCount") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x0" }));
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const store = new MemoryStore();
    const e = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, config: { ...MAINNET, rpcUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, settleTimeoutMs: 5_000 });
    Object.assign(e, { checkChain: async () => {} });
    const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ errorReason?: string }> }).settleOnce.bind(e);
    const d = { txHash: `0x${"d1".repeat(32)}`, raw: "0x02f86c", sender: merchant, amount: 1n, nonce: 0, validUntil: Math.floor(Date.now() / 1000) + 60 };
    const r = await settleOnce(d, req());
    assert.equal(r.errorReason, "tx_rejected");
    assert.ok(!store.isClaimed(d.txHash));
  } finally {
    server.close();
  }
});

test("lookups after a submission are bounded by the settle window too", async () => {
  // Two cases: the reads right after a refusal hang, or only the polling that follows them does.
  for (const answered of [1, 2]) {
    // EOA: the first `answered` receipt lookups answer, every later one hangs.
    const store = new MemoryStore();
    const e = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, settleTimeoutMs: 150, pollIntervalMs: 5 });
    let lookups = 0;
    Object.assign(e, {
      chain: { client: {
        getTransactionReceipt: () => (lookups++ < answered ? Promise.reject(new Error("not found")) : new Promise(() => {})),
        getTransactionCount: () => (answered === 1 ? new Promise(() => {}) : Promise.reject(new Error("unavailable"))),
        sendRawTransaction: async () => { throw new RpcRequestError({ body: {}, error: { code: -32000, message: "nonce too low" }, url: "http://rpc.example" }); },
      } },
      checkChain: async () => {},
    });
    const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ errorReason?: string }> }).settleOnce.bind(e);
    const d = { txHash: `0x${"e1".repeat(32)}`, sender: merchant, amount: 1n, nonce: 0, validUntil: Math.floor(Date.now() / 1000) + 60 };
    let started = Date.now();
    assert.equal((await settleOnce(d, req())).errorReason, "settle_timeout");
    assert.ok(Date.now() - started < 2_500, `EOA, ${answered}: took ${Date.now() - started} ms`);
    assert.ok(store.isClaimed(d.txHash), "the claim is kept: the RPC could not say");

    // User operations: the bundler answers the first `answered` receipt lookups, then hangs.
    let opLookups = 0;
    const server = createServer((r, res) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        res.setHeader("content-type", "application/json");
        if (method === "eth_sendUserOperation") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32500, message: "AA25 invalid account nonce" } }));
        if (method === "eth_getUserOperationByHash") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
        if (opLookups++ < answered) return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
        // later lookups never answer
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const opStore = new MemoryStore();
      const s = userOpScheme(opStore, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      Object.assign(s, { settleTimeoutMs: 150, pollIntervalMs: 5, nonceUsed: answered === 1 ? () => new Promise(() => {}) : async () => undefined });
      started = Date.now();
      assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
      assert.ok(Date.now() - started < 2_500, `user operations, ${answered}: took ${Date.now() - started} ms`);
      assert.ok(opStore.isClaimed(opHash));
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
});

test("user operations: a resend refused while the first copy is queued at the bundler keeps the claim", async () => {
  let queued: boolean | "error" | "unsupported" | "noResult" = true;
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      // A refusal worded in a way the duplicate check does not recognize.
      if (method === "eth_sendUserOperation") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "UserOperation rejected by mempool policy" } }));
      if (method === "eth_getUserOperationByHash") {
        if (queued === "error") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "temporarily unavailable" } }));
        if (queued === "unsupported") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }));
        if (queued === "noResult") return void res.end(JSON.stringify({ jsonrpc: "2.0", id }));
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: queued ? { userOperation: {}, entryPoint: MAINNET.entryPoint, blockNumber: null, transactionHash: null } : null }));
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const store = new MemoryStore();
    const s = userOpScheme(store, url);
    Object.assign(s, { settleTimeoutMs: 50, pollIntervalMs: 5 });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(store.isClaimed(opHash), "queued at the bundler: the claim is kept");
    // A resend after an earlier settle lost its answer (the claim is already held), and the bundler cannot say
    // whether it holds the first copy: the lookup fails, the method is missing, or the answer has no result. The
    // first copy may still be queued, so the claim is kept.
    for (const q of [false, "error", "unsupported", "noResult"] as const) {
      queued = q;
      const earlier = new MemoryStore();
      earlier.claimForSubmission(opHash);
      const u = userOpScheme(earlier, url);
      Object.assign(u, { settleTimeoutMs: 50, pollIntervalMs: 5 });
      assert.equal((await u.settle(opPayload as never, req() as never)).errorReason, "settle_timeout", String(q));
      assert.ok(earlier.isClaimed(opHash), `${q}: the earlier claim is kept`);
    }
    // A first submission has no earlier copy: with the lookup unknown, the unused nonce decides.
    for (const q of [false, "error", "unsupported", "noResult"] as const) {
      queued = q;
      const fresh = new MemoryStore();
      assert.equal((await userOpScheme(fresh, url).settle(opPayload as never, req() as never)).errorReason, "userop_rejected", String(q));
      assert.ok(!fresh.isClaimed(opHash));
    }
  } finally {
    server.close();
  }
});

test("a refused entry is admitted by a payment for its strongest version, which then keeps its place", () => {
  const c = new Catalog(undefined, () => Date.parse("2026-11-20T00:00:00Z"));
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo; i++) {
    assert.equal(c.record(payload(`https://junk.example/${i}`) as never, { ...req(), amount: "10" }, undefined, addr(1 + i)).status, "success");
  }
  const url = "https://api.merchant.example/weather";
  // Version A is paid ten times while the payTo is full: refused each time.
  for (let i = 0; i < 10; i++) assert.equal(c.record(payload(url) as never, req(), undefined, addr(1000 + i)).rejectedReason, "no room for this payTo");
  // Version B's one payment lifts the entry above the weakest listing, but B has earned less than A.
  const b = bazaar();
  b.info.output = { type: "json", example: { other: true } };
  assert.equal(c.record(payload(url, b) as never, req(), undefined, addr(2000)).rejectedReason, "another version of this listing has more recent payments");
  assert.equal(c.list({ payTo: merchant, limit: 100 }).items.some((e) => e.resource === url), false, "nothing was pushed out for it");
  // B is paid 7 more times while waiting (8 in all), each refused while A has earned more.
  for (let i = 1; i < 8; i++) assert.equal(c.record(payload(url, b) as never, req(), undefined, addr(2000 + i)).status, "rejected");
  // A's next payment gets it in, with what it earned (11).
  assert.equal(c.record(payload(url) as never, req(), undefined, addr(1010)).status, "success");
  // B keeps competing from the 8 it earned while waiting: it takes over on its 4th payment after admission (12 > 11).
  const outcomes = [0, 1, 2, 3].map((i) => c.record(payload(url, b) as never, req(), undefined, addr(3000 + i)).status);
  assert.deepEqual(outcomes, ["rejected", "rejected", "rejected", "success"]);
});

test("competing versions are bounded, for listed and for refused entries", () => {
  const c = new Catalog(undefined, () => Date.parse("2026-11-20T00:00:00Z"));
  const url = "https://api.merchant.example/weather";
  const version = (i: number) => {
    const ext = bazaar();
    ext.info.output = { type: "json", example: { v: i } };
    return ext;
  };
  for (let i = 0; i < 5; i++) c.record(payload(url) as never, req(), undefined, addr(100 + i));
  for (let i = 0; i < 6; i++) c.record(payload(url, version(i)) as never, req(), undefined, addr(200 + i));
  const alternatives = (c as unknown as { alternatives: Map<string, unknown[]> }).alternatives;
  assert.equal([...alternatives.values()][0]!.length, CATALOG_LIMITS.maxAlternatives);

  // A refused entry remembers at most maxAlternatives + 1 versions.
  const full = new Catalog(undefined, () => Date.parse("2026-11-20T00:00:00Z"));
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo; i++) full.record(payload(`https://junk.example/${i}`) as never, { ...req(), amount: "100" }, undefined, addr(1 + i));
  for (let i = 0; i < 6; i++) full.record(payload(url, version(i)) as never, req(), undefined, addr(300 + i));
  const pending = (full as unknown as { pending: Map<string, { versions: unknown[] }> }).pending;
  assert.equal([...pending.values()][0]!.versions.length, CATALOG_LIMITS.maxAlternatives + 1);
});

test("the user-operation nonce check reads EntryPoint.getNonce: used when it moved past the operation's nonce", async () => {
  const s = new IncentivUserOpFacilitatorScheme({ log: () => {} });
  let current: bigint | Error = 0n;
  Object.assign(s, { chain: { config: MAINNET, client: { readContract: async () => { if (current instanceof Error) throw current; return current; } } } });
  const nonceUsed = (s as unknown as { nonceUsed(op: unknown): Promise<boolean | undefined> }).nonceUsed.bind(s);
  const op = { sender: merchant, nonce: 5n };
  current = 5n;
  assert.equal(await nonceUsed(op), false);
  current = 6n;
  assert.equal(await nonceUsed(op), true);
  current = new Error("rpc down");
  assert.equal(await nonceUsed(op), undefined);
});

test("the app passes the settled payer to the catalog, so its payments count", async () => {
  const catalog = new Catalog();
  const payers: unknown[] = [];
  catalog.record = (_p, _r, _at, payer) => {
    payers.push(payer);
    return { status: "success" };
  };
  const { app, eoaScheme } = createFacilitatorApp({ discovery: true, catalog, log: () => {} });
  const customer = addr(4242);
  eoaScheme.settle = async () => ({ success: true, payer: customer, transaction: "0x01", network: "eip155:24101", amount: "1" }) as never;
  const { base, close } = await serve(app);
  try {
    await fetch(`${base}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: payload("https://api.example.com/weather"), paymentRequirements: req() }) });
    assert.deepEqual(payers, [customer]);
  } finally {
    await close();
  }
});

test("discovery is off by default: no discovery routes, no bazaar extension, and a settle records nothing", async () => {
  // Any catalog the app might still create would record through the prototype.
  let recorded = 0;
  const record = Catalog.prototype.record;
  Catalog.prototype.record = () => {
    recorded++;
    return { status: "success" };
  };
  let close = async () => {};
  try {
    const made = createFacilitatorApp({ log: () => {} });
    assert.equal(made.catalog, undefined, "no catalog is kept");
    made.eoaScheme.settle = async () => ({ success: true, payer: addr(7), transaction: "0x01", network: "eip155:24101", amount: "1" }) as never;
    const served = await serve(made.app);
    close = served.close;
    const base = served.base;
    // Not served. The answer's body is left to the caller; the service answers JSON (see the service start test).
    assert.equal((await fetch(`${base}/discovery/resources`)).status, 404);
    assert.equal((await fetch(`${base}/discovery/search?query=weather`)).status, 404);
    const supported = (await (await fetch(`${base}/supported`)).json()) as { extensions: string[] };
    assert.deepEqual(supported.extensions, [], "bazaar is not on offer");
    const r = await fetch(`${base}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: payload("https://api.example.com/weather"), paymentRequirements: req() }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { success: boolean }).success, true, "the settle itself is unchanged");
    assert.equal(r.headers.get("extension-responses"), null, "no Bazaar status is sent");
    assert.equal(recorded, 0, "nothing is cataloged");
  } finally {
    Catalog.prototype.record = record;
    await close();
  }
});

test("discovery is on only for discovery: true, and options that contradict each other are refused", () => {
  const log = () => {};
  // A string from a setting is truthy; it must never switch discovery on.
  for (const value of ["off", "on", "true", 1, null]) {
    assert.throws(() => createFacilitatorApp({ discovery: value as never, log }), /discovery must be true or false/, String(value));
  }
  // A catalog with discovery off would be ignored without a word.
  assert.throws(() => createFacilitatorApp({ catalog: new Catalog(), log }), /a catalog needs discovery: true/);
  assert.throws(() => createFacilitatorApp({ discovery: false, catalog: new Catalog(), log }), /a catalog needs discovery: true/);
  assert.equal(createFacilitatorApp({ discovery: false, log }).catalog, undefined);
  const catalog = new Catalog();
  assert.equal(createFacilitatorApp({ discovery: true, catalog, log }).catalog, catalog);
  // The discovery rate limit is checked whether or not discovery is on.
  for (const discovery of [undefined, false, true]) {
    assert.throws(() => createFacilitatorApp({ discovery, discoveryPerMinute: 0, log }), /rate limit must be a positive integer/, String(discovery));
  }
});

test("createFacilitatorApp leaves unknown paths to the caller: a route added after it, or an outer app it is mounted in, is reached", async () => {
  const { app } = createFacilitatorApp({ log: () => {} });
  app.get("/metrics", (_req, res) => {
    res.json({ ok: true });
  });
  const outer = express();
  outer.use(createFacilitatorApp({ log: () => {} }).app);
  outer.get("/merchant", (_req, res) => {
    res.json({ ok: true });
  });
  for (const [served, path] of [[app, "/metrics"], [outer, "/merchant"], [outer, "/supported"]] as const) {
    const { base, close } = await serve(served);
    try {
      assert.equal((await fetch(base + path)).status, 200, path);
    } finally {
      await close();
    }
  }
});

test("with discovery on, the discovery routes and the bazaar extension are on offer", async () => {
  const made = createFacilitatorApp({ discovery: true, log: () => {} });
  assert.ok(made.catalog, "an in-memory catalog is the default");
  made.eoaScheme.settle = async () => ({ success: true, payer: addr(7), transaction: "0x01", network: "eip155:24101", amount: "1" }) as never;
  const { base, close } = await serve(made.app);
  try {
    const supported = (await (await fetch(`${base}/supported`)).json()) as { extensions: string[] };
    assert.deepEqual(supported.extensions, ["bazaar"]);
    const r = await fetch(`${base}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: payload("https://api.example.com/weather"), paymentRequirements: req() }) });
    const status = JSON.parse(Buffer.from(r.headers.get("extension-responses") ?? "", "base64").toString()) as { bazaar: { status: string } };
    assert.equal(status.bazaar.status, "success");
    const listed = (await (await fetch(`${base}/discovery/resources`)).json()) as { items: { resource: string }[] };
    assert.deepEqual(listed.items.map((e) => e.resource), ["https://api.example.com/weather"]);
    assert.equal((await fetch(`${base}/discovery/search?query=weather`)).status, 200);
  } finally {
    await close();
  }
});

test("the service reads and writes catalog.json only with DISCOVERY=on, refuses any other value, and answers JSON for paths it does not serve", { timeout: 60_000 }, async (t) => {
  // The data directories this test creates are removed when it ends, whatever the outcome.
  const dirs: string[] = [];
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  // Starts the real entry point, waits for its "listening" line (or its exit), and stops it.
  // `whileRunning` gets the service's base URL once it listens, before it is stopped.
  const start = async (dir: string, discovery?: string, whileRunning?: (base: string) => Promise<void>) => {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), FACILITATOR_DATA_DIR: dir };
    delete env.DISCOVERY;
    if (discovery !== undefined) env.DISCOVERY = discovery;
    const child = spawn(process.execPath, ["--import", "tsx", "src/facilitator/main.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const lines: Record<string, unknown>[] = [];
    let buffer = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      // Only finished lines are parsed: a chunk can end in the middle of one, and that part waits for the rest.
      buffer += d.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const l of parts) {
        if (!l.trim()) continue;
        try {
          lines.push(JSON.parse(l) as Record<string, unknown>);
        } catch {
          /* not a log line */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const exited = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
    const listening = () => lines.find((l) => l.event === "listening");
    try {
      for (let i = 0; i < 400 && !listening() && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
      if (whileRunning && listening()) await whileRunning(`http://127.0.0.1:${port}`);
    } finally {
      // Whatever happened above, the child is stopped, so a failure cannot leave it running.
      if (child.exitCode === null) child.kill();
    }
    return { line: listening(), code: await exited, err };
  };
  const broken = "{not a catalog";
  const dirWith = () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-discovery-"));
    dirs.push(dir);
    writeFileSync(join(dir, "catalog.json"), broken);
    return dir;
  };

  // Off by default: the file is not touched, although it cannot be read.
  const off = dirWith();
  const stoppedOff = await start(off, undefined, async (base) => {
    // Every path the service does not serve, /discovery/* included with discovery off, answers JSON.
    for (const path of ["/discovery/resources", "/discovery/search?query=weather", "/no-such-path"]) {
      const notServed = await fetch(base + path);
      assert.equal(notServed.status, 404, path);
      assert.match(notServed.headers.get("content-type") ?? "", /^application\/json/, path);
      assert.deepEqual(await notServed.json(), { error: "not_found" }, path);
    }
    const posted = await fetch(`${base}/no-such-path`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(posted.status, 404);
    assert.deepEqual(await posted.json(), { error: "not_found" });
  });
  assert.equal(stoppedOff.line?.discovery, "off", stoppedOff.err);
  assert.deepEqual(readdirSync(off), ["catalog.json"]);
  assert.equal(readFileSync(join(off, "catalog.json"), "utf8"), broken);

  // On: the catalog is loaded, so the unreadable file is moved aside.
  const on = dirWith();
  const stoppedOn = await start(on, "on");
  assert.equal(stoppedOn.line?.discovery, "on", stoppedOn.err);
  assert.ok(readdirSync(on).some((f) => f.startsWith("catalog.json.corrupt-")), readdirSync(on).join(", "));

  // An empty value is an unset one, as for every setting: off.
  const empty = dirWith();
  assert.equal((await start(empty, "")).line?.discovery, "off");
  assert.deepEqual(readdirSync(empty), ["catalog.json"]);

  // Anything else stops startup with a message.
  const refused = await start(dirWith(), "yes");
  assert.equal(refused.line, undefined);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /DISCOVERY must be "on" or "off"/);
});

test("user operations: verify recovers a claimed, successful operation after its deadline too", async () => {
  const bundler = await fakeBundler({ success: true, receipt: { transactionHash: `0x${"11".repeat(32)}` } });
  try {
    const store = new MemoryStore();
    const s = userOpScheme(store, bundler.url);
    const parsed = (s as unknown as { parse(): Record<string, unknown> }).parse();
    Object.assign(s, {
      parse: () => ({ ...parsed, validUntil: Math.floor(Date.now() / 1000) - 60 }),
      checkChain: async () => { throw new PaymentError("nonce_used", "account nonce is 1, operation uses 0"); },
    });
    assert.equal((await s.verify(opPayload as never, req() as never)).invalidReason, "payment_expired", "not claimed: the deadline applies");
    store.claim(opHash);
    assert.equal((await s.verify(opPayload as never, req() as never)).isValid, true);
  } finally {
    bundler.close();
  }
});

test("a pin is written once a later save works", () => {
  class OnceFlaky extends MemoryStore {
    failures = 0;
    saved: Map<string, number> | undefined;
    protected override save() {
      if (this.failures > 0) {
        this.failures--;
        throw new Error("EIO");
      }
      this.saved = new Map(this.claims);
    }
  }
  const store = new OnceFlaky();
  store.claim("0xaa");
  store.failures = 1;
  assert.throws(() => store.set("0xaa", { success: true } as never), /EIO/);
  assert.ok((store.saved?.get("0xaa") ?? 0) > Date.now() + CLAIM_TTL_MS, "the pinned claim time reached storage");
});

test("user operations: a claimed operation past its deadline waits while the bundler may still hold it", async () => {
  let held: "queued" | "absent" | "error" = "queued";
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      if (method === "eth_getUserOperationByHash") {
        if (held === "error") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "unavailable" } }));
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: held === "queued" ? { userOperation: {}, blockNumber: null } : null }));
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const store = new MemoryStore();
    const s = userOpScheme(store, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const parsed = (s as unknown as { parse(): Record<string, unknown> }).parse();
    Object.assign(s, { pollIntervalMs: 5, parse: () => ({ ...parsed, validUntil: Math.floor(Date.now() / 1000) - 60 }) });
    store.claim(opHash);
    // Queued at the bundler, or the bundler cannot say: the claim waits for a receipt.
    for (const h of ["queued", "error"] as const) {
      held = h;
      Object.assign(s, { settleTimeoutMs: 200 });
      assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout", h);
      assert.ok(store.isClaimed(opHash));
    }
    // Not held and the nonce unused: it never landed and cannot, so payment_expired is final.
    held = "absent";
    Object.assign(s, { settleTimeoutMs: 10_000 });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "payment_expired");
    // The nonce read gives no answer: the claim waits.
    Object.assign(s, { settleTimeoutMs: 200, nonceUsed: async () => undefined });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
  } finally {
    server.close();
  }
});


test("verify keeps a claimed payment that may still land valid, in both schemes, and refuses one that cannot", async () => {
  // User operations, past their deadline with no receipt yet.
  let held: "queued" | "absent" | "unsupported" = "queued";
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      if (method === "eth_getUserOperationByHash") {
        if (held === "unsupported") return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }));
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: held === "queued" ? { userOperation: {}, blockNumber: null } : null }));
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const store = new MemoryStore();
    const s = userOpScheme(store, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const parsed = (s as unknown as { parse(): Record<string, unknown> }).parse();
    Object.assign(s, { parse: () => ({ ...parsed, validUntil: Math.floor(Date.now() / 1000) - 60 }) });
    assert.equal((await s.verify(opPayload as never, req() as never)).invalidReason, "payment_expired", "not claimed: expired");
    store.claim(opHash);
    for (const h of ["queued", "unsupported"] as const) {
      held = h;
      assert.equal((await s.verify(opPayload as never, req() as never)).isValid, true, `${h}: may still land`);
    }
    held = "absent";
    assert.equal((await s.verify(opPayload as never, req() as never)).invalidReason, "payment_expired", "cannot land: final");
    // And the settle that follows waits for the receipt without submitting it again.
    held = "queued";
    let sent = false;
    Object.assign(s, { settleTimeoutMs: 200, pollIntervalMs: 5, checkChain: async () => { sent = true; throw new Error("checks must not run"); } });
    assert.equal((await s.settle(opPayload as never, req() as never)).errorReason, "settle_timeout");
    assert.ok(!sent && store.isClaimed(opHash));
  } finally {
    server.close();
  }

  // EOA transfers: past the deadline, and the nonce pending or unknown.
  const eoaStore = new MemoryStore();
  const e = new IncentivEoaTxFacilitatorScheme({ store: eoaStore, log: () => {} });
  const d = { txHash: `0x${"f1".repeat(32)}`, sender: merchant, amount: 1n, nonce: 0, validUntil: Math.floor(Date.now() / 1000) - 60 };
  let count: number | Error = 1;
  Object.assign(e, {
    chain: { client: {
      getTransactionReceipt: async () => { throw new Error("not found"); },
      getTransactionCount: async () => { if (count instanceof Error) throw count; return count; },
    } },
    parse: async () => d,
  });
  assert.equal((await e.verify({} as never, req() as never)).invalidReason, "payment_expired", "not claimed: expired");
  eoaStore.claim(d.txHash);
  assert.equal((await e.verify({} as never, req() as never)).isValid, true, "pending: may still land");
  count = new Error("rpc down");
  assert.equal((await e.verify({} as never, req() as never)).isValid, true, "unknown: may still land");
  count = 0;
  assert.equal((await e.verify({} as never, req() as never)).invalidReason, "payment_expired", "nonce unused: final");
});

test("a self-payment refused at the payTo limit cannot help a waiting listing earn admission", () => {
  const c = new Catalog(undefined, () => Date.parse("2026-11-20T00:00:00Z"));
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo; i++) {
    c.record(payload(`https://incumbent.example/${i}`) as never, { ...req(), amount: "10" }, undefined, addr(1 + i));
  }
  const url = "https://api.merchant.example/waiting";
  const route = { ...req(), amount: "6" };
  assert.equal(c.record(payload(url) as never, route, undefined, route.payTo).rejectedReason, "no room for this payTo");
  const pending = (c as unknown as { pending: Map<string, unknown> }).pending;
  assert.equal(pending.size, 0, "the refused self-payment adds no waiting entry or version score");
  assert.equal(c.record(payload(url) as never, route, undefined, addr(9_001)).rejectedReason, "no room for this payTo");
  assert.equal(c.record(payload(url) as never, route, undefined, addr(9_002)).status, "success");
});

test("self-payments refused by a full catalog are not remembered, and the least paid waiting entry goes first", () => {
  const c = new Catalog(undefined, () => Date.parse("2026-11-20T00:00:00Z"));
  // The merchant's payTo is full of listings paid 10 units each; the rest of the catalog is full too.
  for (let i = 0; i < CATALOG_LIMITS.maxEntriesPerPayTo; i++) c.record(payload(`https://junk.example/${i}`) as never, { ...req(), amount: "10" }, undefined, addr(1 + i));
  for (let i = c.list({}).pagination.total; i < CATALOG_LIMITS.maxEntries; i++) {
    const other = addr(100_000 + i);
    c.record(payload(`https://filler.example/${i}`, bazaar(), other) as never, req(other), undefined, addr(200_000 + i));
  }
  assert.equal(c.list({}).pagination.total, CATALOG_LIMITS.maxEntries);
  // A real route priced 6: its first customer is refused, and what it paid is remembered.
  const url = "https://api.merchant.example/weather";
  const route = { ...req(), amount: "6" };
  assert.equal(c.record(payload(url) as never, route, undefined, addr(9_001)).rejectedReason, "no room for this payTo");
  const pending = (c as unknown as { pending: Map<string, unknown> }).pending;
  // More than maxPendingKeys self-payments to fresh addresses add nothing to remember.
  for (let i = 0; i <= CATALOG_LIMITS.maxPendingKeys; i++) {
    const self = addr(300_000 + i);
    assert.equal(c.record(payload(`https://self.example/${i}`, bazaar(), self) as never, req(self), undefined, self).rejectedReason, "no room in the catalog");
  }
  assert.equal(pending.size, 1, "only the real route waits");
  // Paid refusals at fresh addresses fill the memory, but each paid less than the route: they go first.
  for (let i = 0; i <= CATALOG_LIMITS.maxPendingKeys; i++) {
    const other = addr(400_000 + i);
    c.record(payload(`https://paid.example/${i}`, bazaar(), other) as never, req(other), undefined, addr(500_000 + i));
  }
  assert.equal(pending.size, CATALOG_LIMITS.maxPendingKeys);
  // The second customer's payment gets the route in (6 + 6 > 10).
  assert.equal(c.record(payload(url) as never, route, undefined, addr(9_002)).status, "success");
});

test("a malformed payTo is payto_mismatch, not an internal error", () => {
  const decoded = { token: MAINNET.usdc, to: merchant as `0x${string}`, amount: 1n };
  assert.throws(() => checkPaysRequirements(decoded, { asset: MAINNET.usdc, payTo: "0xnot-an-address", amount: "1" }), (e: unknown) => e instanceof PaymentError && e.reason === "payto_mismatch");
  assert.throws(() => checkPaysRequirements(decoded, { asset: MAINNET.usdc, payTo: undefined as never, amount: "1" }), (e: unknown) => e instanceof PaymentError && e.reason === "payto_mismatch");
  assert.doesNotThrow(() => checkPaysRequirements(decoded, { asset: MAINNET.usdc, payTo: merchant.toLowerCase(), amount: "1" }));
});

test("EOA: a nonce refusal, or a refused resend, keeps the claim even when the reads come from a lagging node", async () => {
  const store = new MemoryStore();
  const e = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, settleTimeoutMs: 100, pollIntervalMs: 5 });
  let sendError: unknown;
  let receipt: { status: string } | undefined;
  Object.assign(e, {
    chain: { client: {
      // A lagging node: no receipt, and the nonce unused even at pending.
      getTransactionReceipt: async () => { if (!receipt) throw new Error("not found"); return receipt; },
      getTransactionCount: async () => 0,
      sendRawTransaction: async () => { throw sendError; },
    } },
    checkChain: async () => {},
  });
  const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ success: boolean; errorReason?: string }> }).settleOnce.bind(e);
  const tx = (n: number) => ({ txHash: `0x${n.toString(16).padStart(64, "0")}`, sender: merchant, ...payment, nonce: 0, validUntil: Math.floor(Date.now() / 1000) + 60 });
  const rpcError = (message: string) => new RpcRequestError({ body: {}, error: { code: -32000, message }, url: "http://rpc.example" });

  // An up-to-date node says "nonce too low"; the reads reach a node that has not seen the payment yet.
  const landed = tx(1);
  sendError = rpcError("nonce too low");
  assert.equal((await settleOnce(landed, req())).errorReason, "settle_timeout");
  assert.ok(store.isClaimed(landed.txHash), "the claim is kept");
  receipt = paidReceipt;
  assert.equal((await settleOnce(landed, req())).success, true, "and the retry reports it once the receipt is visible");
  receipt = undefined;

  // A resend after an earlier settle submitted it: any refusal keeps the claim, the earlier copy may be pending.
  const resent = tx(2);
  store.claim(resent.txHash);
  sendError = rpcError("insufficient funds for gas * price + value");
  assert.equal((await settleOnce(resent, req())).errorReason, "settle_timeout");
  assert.ok(store.isClaimed(resent.txHash));

  // A first submission refused for another reason, with the nonce unused: final.
  const refused = tx(3);
  assert.equal((await settleOnce(refused, req())).errorReason, "tx_rejected");
  assert.ok(!store.isClaimed(refused.txHash));
});

test("EOA payments are sent once per settle: viem does not retry eth_sendRawTransaction", async () => {
  let sends = 0;
  const server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      if (method === "eth_sendRawTransaction") {
        sends++;
        return void res.writeHead(503).end("Service Unavailable"); // viem retries a 503 by default
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const store = new MemoryStore();
    const e = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, config: { ...MAINNET, rpcUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, settleTimeoutMs: 1_500, pollIntervalMs: 50 });
    Object.assign(e, { checkChain: async () => {} });
    const settleOnce = (e as unknown as { settleOnce(d: unknown, r: unknown): Promise<{ errorReason?: string }> }).settleOnce.bind(e);
    const d = { txHash: `0x${"d2".repeat(32)}`, raw: "0x02f86c", sender: merchant, amount: 1n, nonce: 0, validUntil: Math.floor(Date.now() / 1000) + 60 };
    assert.equal((await settleOnce(d, req())).errorReason, "settle_timeout");
    assert.equal(sends, 1, "sent once");
    assert.ok(store.isClaimed(d.txHash), "a 503 is no answer: the claim is kept");
  } finally {
    server.close();
  }
});

test("nonce refusals are recognized in the usual node wordings", () => {
  for (const m of ["nonce too low", "Nonce too low: next nonce 5, tx nonce 4", "nonce has already been used", "replacement transaction underpriced", "OldNonce", "transaction already imported"]) {
    assert.ok(nonceRefusal(m), m);
  }
  for (const m of ["insufficient funds for gas * price + value", "intrinsic gas too low", "invalid sender"]) assert.ok(!nonceRefusal(m), m);
});

test("both schemes recover a two-hour-old submission once and end a replaced nonce after the grace period", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-submission-recovery-"));
  const realNow = Date.now;
  const txHash = `0x${"11".repeat(32)}` as const;
  const to = "0x0000000000000000000000000000000000000001";
  const paid = {
    status: "success",
    logs: [{
      address: MAINNET.usdc,
      topics: viem.encodeEventTopics({ abi: viem.erc20Abi, eventName: "Transfer", args: { from: merchant, to } }),
      data: viem.encodeAbiParameters([{ type: "uint256" }], [1n]),
    }],
  };
  let visible = false;
  let confirmed = false;
  let expired = false;
  let finalLookup: "found" | "error" | "reorg" | undefined;
  let receiptLookups = 0;
  let snapshotNonceUnused = false;
  let historyAvailable = true;
  let sends = 0;
  class RecoveryStore extends FileStore {
    rejectNonceResult = false;
    protected override save() {
      if (this.rejectNonceResult &&
          (this.get(txHash)?.errorReason === "nonce_used" || this.get(opHash)?.errorReason === "nonce_used")) {
        throw new Error("final result write failed");
      }
      super.save();
    }
  }
  const bundler = await fakeBundler(
    (method: string) => method === "eth_sendUserOperation" ? opHash
      : visible || (finalLookup === "found" && receiptLookups === 2) ? { success: true, receipt: { transactionHash: txHash } } : null,
    (method) => method === "eth_getUserOperationReceipt" && finalLookup !== undefined && ++receiptLookups === 2 && finalLookup === "error",
  );
  try {
    for (const scheme of ["eoa", "user-op"]) {
      const cases = ["landed", "replaced", "final lookup", "final error", "reorg", "snapshot reset"];
      if (scheme === "user-op") cases.push("historical");
      for (const outcome of cases) {
        const path = join(dir, `${scheme}-${outcome}.json`);
        const settle = (store: FileStore) => {
          let attemptTime = Date.now();
          const timings = { now: () => attemptTime, settleTimeoutMs: 5_000, pollIntervalMs: 10 };
          const pause = async (deadline: number) => { attemptTime = deadline; };
          const checkDeadline = () => {
            if (expired) throw new PaymentError("payment_expired", "validUntil has passed");
          };
          if (scheme === "user-op") {
            const s = userOpScheme(store, bundler.url);
            const scheme = s as unknown as { parse(): { validUntil: number }; chain: { client: object } };
            const parsed = { ...scheme.parse(), validUntil: Math.floor(realNow() / 1000) + 60 };
            Object.assign(s, { ...timings, pause, checkDeadline, parse: () => parsed, nonceUsed: async () => confirmed });
            Object.assign(scheme.chain.client, {
              getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({
                number: blockNumber ?? 1n,
                hash: finalLookup === "reorg" && receiptLookups >= 2 ? `0x${"12".repeat(32)}` : txHash,
                parentHash: txHash,
                timestamp: BigInt(Math.floor(realNow() / 1000) + (blockNumber === 0n ? -3600 : 7200)),
              }),
              readContract: async () => snapshotNonceUnused ? 0n : 1n,
              getLogs: async ({ blockHash, args }: { blockHash?: string; args: { userOpHash: string } }) => {
                if (!historyAvailable) throw new Error("archive RPC unavailable");
                if (blockHash) assert.equal(blockHash, txHash);
                assert.equal(args.userOpHash, opHash);
                return outcome === "historical" ? [{
                  transactionHash: txHash, blockNumber: 1n, blockHash: txHash, removed: false,
                  args: { userOpHash: opHash, sender: merchant, nonce: 0n, success: true },
                }] : [];
              },
            });
            return () => s.settle(opPayload as never, req());
          }
          const s = new IncentivEoaTxFacilitatorScheme({ ...timings, store, log: () => {} });
          Object.assign(s, {
            parse: async () => ({ txHash, sender: merchant, token: MAINNET.usdc, to, amount: 1n, nonce: 0 }),
            pause,
            checkDeadline,
            checkChain: async () => {},
            chain: { client: {
              getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({
                number: 1n,
                hash: finalLookup === "reorg" && blockNumber === 1n ? `0x${"12".repeat(32)}` : txHash,
              }),
              getTransactionReceipt: async () => {
                const recheck = finalLookup !== undefined && ++receiptLookups === 2;
                if (recheck && finalLookup === "error") throw new Error("receipt RPC unavailable");
                if (!visible && !(recheck && finalLookup === "found")) {
                  throw new viem.TransactionReceiptNotFoundError({ hash: txHash });
                }
                return paid;
              },
              getTransactionCount: async ({ blockTag, blockHash, requireCanonical }: { blockTag?: string; blockHash?: string; requireCanonical?: boolean }) => {
                if (blockTag === "pending") return 0;
                if (blockHash) {
                  assert.equal(blockHash, txHash);
                  assert.equal(requireCanonical, true);
                  return snapshotNonceUnused ? 0 : 1;
                }
                assert.equal(blockTag, "latest");
                return confirmed ? 1 : 0;
              },
              sendRawTransaction: async () => { sends++; },
            } },
          });
          return () => s.settle({} as never, req());
        };
        const start = realNow();
        Date.now = () => start;
        visible = confirmed = expired = false;
        finalLookup = undefined;
        snapshotNonceUnused = false;
        historyAvailable = true;
        receiptLookups = 0;
        const sentBefore = sends + bundler.methods.filter((m) => m === "eth_sendUserOperation").length;
        assert.equal((await settle(new FileStore(path))()).errorReason, "settle_timeout", scheme);
        const hash = scheme === "eoa" ? txHash : opHash;
        assert.ok(new FileStore(path).isSubmitted(hash), scheme);

        const late = start + 2 * CLAIM_TTL_MS;
        Date.now = () => late;
        const recoveredStore = new RecoveryStore(path);
        expired = true;
        if (outcome === "replaced") {
          assert.equal((await settle(recoveredStore)()).errorReason, "settle_timeout", "expired submission with an unused nonce stays retryable");
        }
        confirmed = true;
        visible = outcome === "landed";
        if (outcome === "landed" || outcome === "historical") {
          const response = await settle(recoveredStore)();
          assert.equal(response.success, true, JSON.stringify({ scheme, outcome, response }));
          assert.equal((await settle(recoveredStore)()).errorReason, "already_settled", scheme);
        } else {
          if (scheme === "user-op" && outcome === "replaced") historyAvailable = false;
          assert.equal((await settle(recoveredStore)()).errorReason, "settle_timeout", scheme);
          Date.now = () => late + NONCE_USED_GRACE_MS;
          if (scheme === "user-op" && outcome === "replaced") {
            historyAvailable = false;
            assert.equal((await settle(recoveredStore)()).errorReason, "settle_timeout");
            assert.ok(new FileStore(path).isClaimed(hash), "an incomplete historical search cannot consume the claim");
            historyAvailable = true;
          }
          if (outcome === "replaced") {
            recoveredStore.rejectNonceResult = true;
            assert.equal((await settle(recoveredStore)()).errorReason, "settle_timeout", scheme);
            assert.equal(recoveredStore.get(hash), undefined, scheme);
            assert.ok(new FileStore(path).isSubmitted(hash), scheme);
            recoveredStore.rejectNonceResult = false;
          }
          if (outcome === "reorg" || outcome === "snapshot reset") {
            if (outcome === "reorg") finalLookup = "reorg";
            else snapshotNonceUnused = true;
            assert.equal((await settle(recoveredStore)()).errorReason, "settle_timeout");
            assert.ok(new FileStore(path).isClaimed(hash));
            finalLookup = undefined;
            snapshotNonceUnused = false;
            assert.equal((await settle(recoveredStore)()).errorReason, "settle_timeout", "grace restarts");
            Date.now = () => late + 2 * NONCE_USED_GRACE_MS;
          }
          if (outcome === "final lookup") finalLookup = "found";
          if (outcome === "final error") finalLookup = "error";
          const final = await settle(recoveredStore)();
          if (finalLookup === "found") {
            assert.equal(receiptLookups, 2);
            assert.equal(final.success, true, "a receipt found on the final recheck is reported");
          } else if (finalLookup === "error") {
            assert.equal(final.errorReason, "settle_timeout");
            assert.ok(new FileStore(path).isClaimed(hash));
            assert.equal(new FileStore(path).get(hash), undefined);
            finalLookup = undefined;
            visible = true;
            assert.equal((await settle(recoveredStore)()).success, true);
          } else {
            assert.equal(final.errorReason, "nonce_used", scheme);
          }
          assert.equal(new FileStore(path).isClaimed(hash), false, scheme);
        }
        assert.equal(sends + bundler.methods.filter((m) => m === "eth_sendUserOperation").length, sentBefore + 1, scheme);
      }
    }
  } finally {
    Date.now = realNow;
    bundler.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a settlement nonce check restarts grace after the first user-operation nonce read fails", async () => {
  const bundler = await fakeBundler(null);
  try {
    const store = new MemoryStore();
    const now = Date.now();
    store.claimForSubmission(opHash);
    store.nonceUsedPastGrace(opHash, true, now - NONCE_USED_GRACE_MS - 1);
    let nonceReads = 0;
    let failFirstNonceRead = false;
    const scheme = new IncentivUserOpFacilitatorScheme({ store, now: () => now, log: () => {} });
    Object.assign(scheme, {
      parse: () => ({
        op: { sender: merchant, nonce: 0n }, userOpHash: opHash, decoded: { amount: 1n },
        payer: merchant, validUntil: Math.floor(now / 1000) + 60, maxTimeoutSeconds: 120,
      }),
      chain: { config: { ...MAINNET, bundlerUrl: bundler.url }, client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          assert.equal(functionName, "getNonce");
          if (++nonceReads === 1 && failFirstNonceRead) throw new Error("first nonce read unavailable");
          return 0n;
        },
        getCode: async () => "0x",
      } },
    });

    const verification = await scheme.verify(opPayload as never, req());
    assert.equal(verification.invalidReason, "invalid_signature");
    assert.equal(store.nonceUsedPastGrace(opHash, true, now), true, "verify keeps the stored observation");

    nonceReads = 0;
    failFirstNonceRead = true;
    const result = await scheme.settle(opPayload as never, req());
    assert.equal(result.errorReason, "invalid_signature", "later checks can fail after the nonce was observed");
    assert.equal(nonceReads, 2);
    assert.equal(store.nonceUsedPastGrace(opHash, true, now), false, "the old timer was cleared");
    assert.equal(store.nonceUsedPastGrace(opHash, true, now + NONCE_USED_GRACE_MS - 1), false);
    assert.equal(store.nonceUsedPastGrace(opHash, true, now + NONCE_USED_GRACE_MS), true);
  } finally {
    bundler.close();
  }
});

test("EOA retries clear an old grace observation when the receipt RPC fails and a nonce read shows unused", async () => {
  const hash = `0x${"a1".repeat(32)}` as const;
  for (const nonceReadDuringChecks of [false, true]) {
    const store = new MemoryStore();
    const s = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, settleTimeoutMs: 250, pollIntervalMs: 10 });
    const now = Date.now();
    store.claimForSubmission(hash);
    store.nonceUsedPastGrace(hash, true, now - NONCE_USED_GRACE_MS - 1);
    let reads = 0;
    Object.assign(s, {
      parse: async () => ({ txHash: hash, sender: merchant, nonce: 0, validUntil: Math.floor(now / 1000) + (nonceReadDuringChecks ? 30 : -1) }),
      chain: { client: {
        getTransactionReceipt: async () => { throw new Error("receipt RPC unavailable"); },
        getTransactionCount: async () => {
          if (++reads === 1 && nonceReadDuringChecks) throw new Error("first nonce read unavailable");
          return 0;
        },
        readContract: async () => { throw new Error("stop after the settlement checks read the nonce"); },
        getBalance: async () => 0n,
      } },
    });
    const result = await s.settle({} as never, req());
    assert.equal(result.errorReason, nonceReadDuringChecks ? "unexpected_settle_error" : "settle_timeout");
    assert.equal(reads, nonceReadDuringChecks ? 2 : 1);
    assert.equal(store.nonceUsedPastGrace(hash, true, now + 1_000), false, "a new advance starts a fresh grace period");
  }
});

test("read-only EOA recovery polling lets another payment from the payer submit", async () => {
  const oldHash = `0x${"a2".repeat(32)}` as const;
  const newHash = `0x${"a3".repeat(32)}` as const;
  const recipient = "0x0000000000000000000000000000000000000001";
  const paid = {
    status: "success",
    logs: [{
      address: MAINNET.usdc,
      topics: viem.encodeEventTopics({ abi: viem.erc20Abi, eventName: "Transfer", args: { from: merchant, to: recipient } }),
      data: viem.encodeAbiParameters([{ type: "uint256" }], [1n]),
    }],
  };
  const store = new MemoryStore();
  store.claimForSubmission(oldHash);
  const s = new IncentivEoaTxFacilitatorScheme({ store, log: () => {}, settleTimeoutMs: 1_000, pollIntervalMs: 5 });
  let polled!: () => void;
  const pollStarted = new Promise<void>((resolve) => { polled = resolve; });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  let pauses = 0;
  let submissions = 0;
  let oldVisible = false;
  Object.assign(s, {
    parse: async ({ payload }: { payload: { txHash: string } }) => ({
      txHash: payload.txHash, sender: merchant, nonce: 0, token: MAINNET.usdc, to: recipient, amount: 1n,
      validUntil: Math.floor(Date.now() / 1000) + (payload.txHash === oldHash ? -1 : 30),
    }),
    checkChain: async () => {},
    pause: async () => {
      if (++pauses !== 1) return;
      polled();
      await paused;
    },
    chain: { client: {
      getTransactionReceipt: async ({ hash }: { hash: viem.Hex }) => {
        if (hash === oldHash ? oldVisible : submissions > 0) return paid;
        throw new viem.TransactionReceiptNotFoundError({ hash });
      },
      getTransactionCount: async () => 0,
      sendRawTransaction: async () => { submissions++; },
    } },
  });

  const oldSettle = s.settle({ payload: { txHash: oldHash } } as never, req());
  try {
    await Promise.race([pollStarted, oldSettle.then(() => assert.fail("recovery never began polling"))]);
    assert.equal((await s.settle({ payload: { txHash: newHash } } as never, req())).success, true);
    assert.equal(submissions, 1);
  } finally {
    oldVisible = true;
    resume();
    await oldSettle;
  }
  assert.equal((await oldSettle).success, true);
});
