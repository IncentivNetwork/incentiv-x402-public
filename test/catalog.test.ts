import assert from "node:assert/strict";
import test from "node:test";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { Catalog } from "../src/facilitator/catalog.js";

const req = { scheme: "incentiv-eoa-tx", network: "eip155:24101" as const, asset: "0x16e43840d8D79896A389a3De85aB0B0210C05685", amount: "10000", payTo: "0x832166144c59Ed3524878441fa67F91615d2133B", maxTimeoutSeconds: 120, extra: {} };
// The resource server's Bazaar extension adds the HTTP method when it enriches the declaration; do the same here.
const ext = declareDiscoveryExtension({ output: { example: { ok: true } } });
(ext.bazaar as unknown as { info: { input: Record<string, unknown> } }).info.input.method = "GET";
const payload = (over: Record<string, unknown> = {}) => ({
  x402Version: 2,
  resource: { url: "https://api.example.com/weather", description: "Weather", mimeType: "application/json", serviceName: "Weather", tags: ["weather"] },
  accepted: req,
  payload: {},
  extensions: ext,
  ...over,
});

test("a settled payment that declared discovery info is cataloged and listed", () => {
  const c = new Catalog();
  assert.equal(c.record(payload() as never, req).status, "success");
  const list = c.list({});
  assert.equal(list.pagination.total, 1);
  assert.equal(list.items[0]!.resource, "https://api.example.com/weather");
  assert.equal(list.items[0]!.accepts[0]!.payTo, req.payTo);
  assert.equal(list.items[0]!.serviceName, "Weather");
});

test("without discovery info nothing is cataloged", () => {
  const c = new Catalog();
  const r = c.record(payload({ extensions: undefined }) as never, req);
  assert.equal(r.status, "rejected");
  assert.equal(c.list({}).pagination.total, 0);
});

test("filters by payTo, scheme and network, and pages", () => {
  const c = new Catalog();
  c.record(payload() as never, req);
  c.record(payload({ resource: { url: "https://api.example.com/other" } }) as never, { ...req, payTo: "0x000000000000000000000000000000000000dEaD" });
  assert.equal(c.list({ payTo: req.payTo }).items.length, 1);
  assert.equal(c.list({ scheme: "nope" }).items.length, 0);
  assert.equal(c.list({ network: "eip155:24101" }).items.length, 2);
  const page = c.list({ limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.pagination.total, 2);
});

test("search matches words across url, description, name and tags", () => {
  const c = new Catalog();
  c.record(payload() as never, req);
  assert.equal(c.search({ query: "weather" }).resources.length, 1);
  assert.equal(c.search({ query: "WEATHER api" }).resources.length, 1);
  assert.equal(c.search({ query: "weather nothing" }).resources.length, 0);
  assert.equal(c.search({ query: "" }).resources.length, 1);
});

test("the Bazaar server extension is the one from the stock package", () => {
  assert.equal(typeof bazaarResourceServerExtension, "object");
});
