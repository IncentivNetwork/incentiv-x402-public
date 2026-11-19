import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { formatEther, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createFacilitatorApp,
  EOA_SCHEME,
  IncentivEoaTxClientScheme,
  IncentivEoaTxFacilitatorScheme,
  makeChain,
  MAINNET,
  MemoryStore,
  NETWORK,
  SCHEME,
} from "../src/index.js";
import { erc20Abi } from "../src/abi.js";
import { createMerchant } from "./merchant.js";

// The plain-EOA payer: the owner key's own address, the same on every chain.
const PRICE = 10_000n; // $0.01
const FACILITATOR_PORT = 4130;
const MERCHANT_PORT = 4131;
const MIN_USDC = 100_000n; // 0.10 USDC covers four $0.01 payments with room to spare
const MIN_CENT = BigInt(process.env.E2E_MIN_CENT ?? "12") * 10n ** 18n; // four transfers at about 2.5 CENT of gas each

const env = Object.fromEntries(readFileSync(".env.e2e", "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
const owner = privateKeyToAccount(env.E2E_PAYER_KEY as Hex);
const payer = owner.address;
const merchant = privateKeyToAccount(env.E2E_MERCHANT_KEY as Hex).address;
const chain = makeChain();
const clientScheme = new IncentivEoaTxClientScheme({ owner });
const usdc = (a: Address) => chain.client.readContract({ address: MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const cent = (a: Address) => chain.client.getBalance({ address: a });

// E2E_ONLY="paid request,discovery" runs only tests whose names contain one of the comma-separated parts.
const only = process.env.E2E_ONLY?.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
let failures = 0;
const results: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  if (only && !only.some((part) => name.toLowerCase().includes(part))) return;
  const started = Date.now();
  try {
    await fn();
    results.push(`PASS  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures++;
    results.push(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
  }
  console.log(results.at(-1));
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const usdcStart = await usdc(payer);
const centStart = await cent(payer);
console.log(`payer EOA ${payer} holds ${formatUnits(usdcStart, 6)} USDC and ${formatEther(centStart)} CENT on Incentiv; merchant ${merchant}`);
if (usdcStart < MIN_USDC || centStart < MIN_CENT) {
  console.error(`The EOA payer needs at least ${formatUnits(MIN_USDC, 6)} USDC and ${formatEther(MIN_CENT)} CENT on Incentiv mainnet. Fund ${payer} and run again.`);
  process.exit(2);
}

const store = new MemoryStore();
const { app: facilitatorApp } = createFacilitatorApp({ store });
const servers: Server[] = [];
await new Promise<void>((ok) => servers.push(facilitatorApp.listen(FACILITATOR_PORT, () => ok())));
const facilitatorUrl = `http://localhost:${FACILITATOR_PORT}`;
await new Promise<void>((ok) => servers.push(createMerchant({ facilitatorUrl, payTo: merchant }).listen(MERCHANT_PORT, () => ok())));
await new Promise((r) => setTimeout(r, 1500));
const url = `http://localhost:${MERCHANT_PORT}/weather`;

const buyer = new x402Client();
buyer.register(NETWORK, clientScheme);
let lastSignature: string | undefined;
const spy: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  lastSignature = headers.get("PAYMENT-SIGNATURE") ?? lastSignature;
  return fetch(input, init);
};
const payingFetch = wrapFetchWithPayment(spy, buyer);
const post = (path: string, body: unknown) =>
  fetch(`${facilitatorUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, any>>);

await test("facilitator /supported lists incentiv-eoa-tx and incentiv-userop", async () => {
  const s = (await (await fetch(`${facilitatorUrl}/supported`)).json()) as { kinds: { scheme: string; network: string }[] };
  for (const scheme of [EOA_SCHEME, SCHEME]) assert(s.kinds.some((k) => k.scheme === scheme && k.network === NETWORK), JSON.stringify(s));
  assert((s as unknown as { extensions: string[] }).extensions.includes("bazaar"), "bazaar extension is not advertised");
});

let requirements: any;
await test("unpaid request gets a v2 402 offering both schemes", async () => {
  const res = await fetch(url);
  assert(res.status === 402, `status ${res.status}`);
  const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
  assert(pr.x402Version === 2, "not v2");
  requirements = pr.accepts.find((a: any) => a.scheme === EOA_SCHEME);
  assert(requirements && pr.accepts.some((a: any) => a.scheme === SCHEME), "both schemes should be offered");
  assert(requirements.amount === PRICE.toString() && requirements.maxTimeoutSeconds === 120, JSON.stringify(requirements));
  assert(requirements.payTo.toLowerCase() === merchant.toLowerCase(), "wrong payTo");
});

const merchantStart = await usdc(merchant);
await test("paid request: stock @x402/fetch pays from the EOA and the merchant is served", async () => {
  const res = await payingFetch(url);
  assert(res.status === 200, `status ${res.status}: ${await res.text()}`);
  const settled = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
  assert(settled.success && /^0x[0-9a-f]{64}$/i.test(settled.transaction), JSON.stringify(settled));
  assert(settled.payer?.toLowerCase() === payer.toLowerCase(), "wrong payer");
  assert((await usdc(merchant)) - merchantStart === PRICE, "merchant did not receive exactly the price");
  assert(usdcStart - (await usdc(payer)) === PRICE, "payer USDC did not drop by exactly the price");
  console.log(`   gas paid ${formatEther(centStart - (await cent(payer)))} CENT; tx ${settled.transaction}`);
});

await test("discovery: the paid resource is cataloged and found by list, filter and search", async () => {
  const list = (await (await fetch(`${facilitatorUrl}/discovery/resources?type=http`)).json()) as { x402Version: number; items: any[]; pagination: { total: number } };
  assert(list.x402Version === 2 && list.pagination.total >= 1, JSON.stringify(list));
  const item = list.items.find((i) => i.resource.endsWith("/weather"));
  assert(item, `weather not listed: ${JSON.stringify(list)}`);
  assert(item.accepts[0].payTo.toLowerCase() === merchant.toLowerCase() && item.accepts[0].network === NETWORK, JSON.stringify(item.accepts));
  assert(item.serviceName === "Incentiv Demo Weather" && item.tags?.includes("weather"), JSON.stringify(item));
  assert(item.extensions?.bazaar, "no bazaar extension echoed");
  const byPayTo = (await (await fetch(`${facilitatorUrl}/discovery/resources?payTo=${merchant}&network=${NETWORK}`)).json()) as { items: any[] };
  assert(byPayTo.items.length >= 1, "payTo and network filters found nothing");
  const none = (await (await fetch(`${facilitatorUrl}/discovery/resources?payTo=0x000000000000000000000000000000000000dEaD`)).json()) as { items: any[] };
  assert(none.items.length === 0, "a payTo filter returned an unrelated resource");
  const found = (await (await fetch(`${facilitatorUrl}/discovery/search?query=weather%20kyiv`)).json()) as { resources: any[] };
  assert(found.resources.some((r) => r.resource.endsWith("/weather")), "search did not find the resource");
  const missing = (await (await fetch(`${facilitatorUrl}/discovery/search?query=nonexistentthing`)).json()) as { resources: any[] };
  assert(missing.resources.length === 0, "search matched a query it should not");
});

await test("replaying the same PAYMENT-SIGNATURE is refused and moves no money", async () => {
  assert(lastSignature, "no captured signature");
  const before = await usdc(merchant);
  const res = await fetch(url, { headers: { "PAYMENT-SIGNATURE": lastSignature } });
  assert(res.status === 402, `status ${res.status}`);
  assert((await usdc(merchant)) === before, "merchant balance changed");
});

const verify = (accepted: any, payload: any, reqs = accepted) => post("/verify", { paymentPayload: { x402Version: 2, accepted, payload }, paymentRequirements: reqs });

await test("a different recipient is rejected at verify (payto_mismatch)", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const other = { ...requirements, payTo: "0x000000000000000000000000000000000000dEaD" };
  const v = await verify(other, p.payload);
  assert(v.isValid === false && v.invalidReason === "payto_mismatch", JSON.stringify(v));
});

await test("a different amount is rejected at verify (amount_mismatch)", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const other = { ...requirements, amount: (PRICE + 1n).toString() };
  const v = await verify(other, p.payload);
  assert(v.isValid === false && v.invalidReason === "amount_mismatch", JSON.stringify(v));
});

await test("a tampered transaction is rejected at verify", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const raw = (p.payload as { signedTransaction: string }).signedTransaction;
  const tampered = `${raw.slice(0, -2)}${raw.endsWith("00") ? "01" : "00"}`;
  const v = await verify(requirements, { signedTransaction: tampered });
  assert(v.isValid === false, JSON.stringify(v));
});

await test("a payment presented after its deadline is rejected (payment_expired)", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const late = new IncentivEoaTxFacilitatorScheme({ now: () => Date.now() + 10 * 60_000 });
  const v = await late.verify({ x402Version: 2, accepted: requirements, payload: p.payload }, requirements);
  assert(!v.isValid && v.invalidReason === "payment_expired", JSON.stringify(v));
});

await test("a valid payload verifies without spending anything", async () => {
  const before = await usdc(payer);
  const beforeCent = await cent(payer);
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const v = await verify(requirements, p.payload);
  assert(v.isValid === true && v.payer?.toLowerCase() === payer.toLowerCase(), JSON.stringify(v));
  assert((await usdc(payer)) === before && (await cent(payer)) === beforeCent, "balance changed on verify");
});

await test("a second payment from the same EOA while one settles is rejected (payer_busy)", async () => {
  const before = await usdc(merchant);
  const a = await clientScheme.createPaymentPayload(2, requirements);
  const b = await clientScheme.createPaymentPayload(2, requirements);
  const settling = post("/settle", { paymentPayload: { x402Version: 2, accepted: requirements, payload: a.payload }, paymentRequirements: requirements });
  await new Promise((r) => setTimeout(r, 1200));
  const v = await verify(requirements, b.payload);
  assert(v.isValid === false && v.invalidReason === "payer_busy", JSON.stringify(v));
  const first = await settling;
  assert(first.success === true, JSON.stringify(first));
  assert((await usdc(merchant)) - before === PRICE, "merchant did not receive exactly one payment");
});

await test("settle timeout, then a retry of the same payload, produces exactly one transfer", async () => {
  const before = await usdc(merchant);
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const payload = { x402Version: 2, accepted: requirements, payload: p.payload };
  const impatient = new IncentivEoaTxFacilitatorScheme({ settleTimeoutMs: 1, pollIntervalMs: 1 });
  const first = await impatient.settle(payload, requirements);
  assert(!first.success && first.errorReason === "settle_timeout", JSON.stringify(first));
  const second = await post("/settle", { paymentPayload: payload, paymentRequirements: requirements });
  assert(second.success === true, JSON.stringify(second));
  const again = await post("/settle", { paymentPayload: payload, paymentRequirements: requirements });
  assert(again.success === false && again.errorReason === "already_settled", `a repeated settle must not succeed again: ${JSON.stringify(again)}`);
  assert((await usdc(merchant)) - before === PRICE, "merchant did not receive exactly one payment");
});

await test("two simultaneous payments from one EOA: exactly one is served", async () => {
  const before = await usdc(merchant);
  const [a, b] = await Promise.allSettled([payingFetch(url), payingFetch(url)]);
  const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : 0));
  assert(statuses.filter((s) => s === 200).length === 1, `statuses ${statuses}`);
  assert((await usdc(merchant)) - before === PRICE, "merchant did not receive exactly one payment");
});

servers.forEach((s) => s.close());
console.log(`\n${results.length - failures}/${results.length} passed. Payer spent ${formatUnits(usdcStart - (await usdc(payer)), 6)} USDC and ${formatEther(centStart - (await cent(payer)))} CENT in total.`);
process.exit(failures ? 1 : 0);
