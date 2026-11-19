import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createFacilitatorApp,
  IncentivUserOpClientScheme,
  IncentivUserOpFacilitatorScheme,
  makeChain,
  MAINNET,
  MemoryStore,
  NETWORK,
  SCHEME,
} from "../src/index.js";
import { erc20Abi } from "../src/abi.js";
import { getOpReceipt } from "../src/userop.js";
import { createMerchant } from "./merchant.js";

const PRICE = 10_000n; // $0.01
const FACILITATOR_PORT = 4120;
const MERCHANT_PORT = 4121;
// E2E_GAS=cent pays gas in CENT from the account instead of USDC through the paymaster.
const nativeGas = process.env.E2E_GAS === "cent";
const MIN_PAYER_BALANCE = BigInt(process.env.E2E_MIN_USDC_ATOMIC ?? (nativeGas ? "50000" : "400000")); // covers the whole run with room to spare

const env = Object.fromEntries(
  readFileSync(".env.e2e", "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]),
);
const owner = privateKeyToAccount(env.E2E_PAYER_KEY as Hex);
const merchant = privateKeyToAccount(env.E2E_MERCHANT_KEY as Hex).address;
const chain = makeChain();
const clientScheme = new IncentivUserOpClientScheme({ owner, gas: nativeGas ? "native" : "token" });
const payer = await clientScheme.account();
const usdcBalance = (a: Address) => chain.client.readContract({ address: MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] });

// E2E_ONLY="paid request,replaying" runs only tests whose names contain one of the comma-separated parts.
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

const payerStart = await usdcBalance(payer);
console.log(`payer ${payer} holds ${formatUnits(payerStart, 6)} USDC; merchant ${merchant}`);
if (payerStart < MIN_PAYER_BALANCE) {
  console.error(`Fund the payer with at least ${formatUnits(MIN_PAYER_BALANCE, 6)} USDC (about $2 is plenty) and run again.`);
  process.exit(2);
}

// Facilitator and merchant, both in this process.
const store = new MemoryStore();
const { app: facilitatorApp } = createFacilitatorApp({ store });
const servers: Server[] = [];
await new Promise<void>((ok) => servers.push(facilitatorApp.listen(FACILITATOR_PORT, () => ok())));
const facilitatorUrl = `http://localhost:${FACILITATOR_PORT}`;
const merchantApp = createMerchant({ facilitatorUrl, payTo: merchant });
await new Promise<void>((ok) => servers.push(merchantApp.listen(MERCHANT_PORT, () => ok())));
await new Promise((r) => setTimeout(r, 1500)); // let the merchant sync /supported
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

await test("facilitator /supported lists incentiv-userop on eip155:24101", async () => {
  const s = (await (await fetch(`${facilitatorUrl}/supported`)).json()) as { kinds: { scheme: string; network: string; x402Version: number }[] };
  assert(s.kinds.some((k) => k.scheme === SCHEME && k.network === NETWORK && k.x402Version === 2), JSON.stringify(s));
});

await test("facilitator /health reports rpc and bundler ok", async () => {
  const h = (await (await fetch(`${facilitatorUrl}/health`)).json()) as { status: string };
  assert(h.status === "ok", JSON.stringify(h));
});

let requirements: any;
await test("unpaid request gets a v2 402 with incentiv-userop requirements", async () => {
  const res = await fetch(url);
  assert(res.status === 402, `status ${res.status}`);
  const header = res.headers.get("PAYMENT-REQUIRED");
  assert(header, "no PAYMENT-REQUIRED header");
  const pr = decodePaymentRequiredHeader(header);
  assert(pr.x402Version === 2, "not v2");
  requirements = pr.accepts.find((x: any) => x.scheme === SCHEME);
  assert(requirements, "no incentiv-userop entry in accepts");
  assert(requirements.scheme === SCHEME && requirements.network === NETWORK, "wrong scheme or network");
  assert(requirements.amount === PRICE.toString(), `amount ${requirements.amount}`);
  assert(requirements.asset.toLowerCase() === MAINNET.usdc.toLowerCase(), "wrong asset");
  assert(requirements.payTo.toLowerCase() === merchant.toLowerCase(), "wrong payTo");
  assert(requirements.maxTimeoutSeconds === 120, `timeout ${requirements.maxTimeoutSeconds}`);
  assert(requirements.extra.entryPoint.toLowerCase() === MAINNET.entryPoint.toLowerCase(), "wrong entryPoint");
});

const merchantStart = await usdcBalance(merchant);
let firstTx = "";
await test("paid request: stock @x402/fetch pays, merchant serves, PAYMENT-RESPONSE carries the transaction", async () => {
  const deployedBefore = ((await chain.client.getCode({ address: payer })) ?? "0x") !== "0x";
  const res = await payingFetch(url);
  assert(res.status === 200, `status ${res.status}: ${await res.text()}`);
  const settled = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
  assert(settled.success && /^0x[0-9a-f]{64}$/i.test(settled.transaction), JSON.stringify(settled));
  firstTx = settled.transaction;
  assert(settled.payer?.toLowerCase() === payer.toLowerCase(), "wrong payer");
  const received = (await usdcBalance(merchant)) - merchantStart;
  assert(received === PRICE, `merchant received ${received}, expected ${PRICE}`);
  const spent = payerStart - (await usdcBalance(payer));
  console.log(`   deployed account: ${!deployedBefore}; paid ${formatUnits(PRICE, 6)} + gas ${formatUnits(spent - PRICE, 6)} USDC; tx ${firstTx}`);
  if (nativeGas) assert(spent === PRICE, `with gas in CENT the payer's USDC should drop by exactly the price, not ${spent}`);
  else assert(spent > PRICE && spent < PRICE + 150_000n, `payer spent ${spent}`);
});

await test("replaying the same PAYMENT-SIGNATURE is refused and moves no money", async () => {
  assert(lastSignature, "no captured signature");
  const before = await usdcBalance(merchant);
  const res = await fetch(url, { headers: { "PAYMENT-SIGNATURE": lastSignature } });
  assert(res.status === 402, `status ${res.status}`);
  assert((await usdcBalance(merchant)) === before, "merchant balance changed");
});

await test("a payload for a different recipient is rejected at verify (payto_mismatch), nothing broadcast", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const other = { ...requirements, payTo: "0x000000000000000000000000000000000000dEaD" };
  const v = await post("/verify", { paymentPayload: { x402Version: 2, accepted: other, payload: p.payload }, paymentRequirements: other });
  assert(v.isValid === false && v.invalidReason === "payto_mismatch", JSON.stringify(v));
});

await test("a payload for a different amount is rejected at verify (amount_mismatch)", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const other = { ...requirements, amount: (PRICE + 1n).toString() };
  const v = await post("/verify", { paymentPayload: { x402Version: 2, accepted: other, payload: p.payload }, paymentRequirements: other });
  assert(v.isValid === false && v.invalidReason === "amount_mismatch", JSON.stringify(v));
});

await test("a tampered operation fails the signature check", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const payload = JSON.parse(JSON.stringify(p.payload));
  payload.userOperation.maxFeePerGas = "0x" + (BigInt(payload.userOperation.maxFeePerGas) + 1n).toString(16);
  const v = await post("/verify", { paymentPayload: { x402Version: 2, accepted: requirements, payload }, paymentRequirements: requirements });
  assert(v.isValid === false && ["invalid_payload", "invalid_signature"].includes(v.invalidReason), JSON.stringify(v));
});

await test("a payment presented after validUntil is rejected (payment_expired)", async () => {
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const late = new IncentivUserOpFacilitatorScheme({ now: () => Date.now() + 10 * 60_000 });
  const v = await late.verify({ x402Version: 2, accepted: requirements, payload: p.payload }, requirements);
  assert(!v.isValid && v.invalidReason === "payment_expired", JSON.stringify(v));
});

await test("a valid payload verifies without spending anything", async () => {
  const before = await usdcBalance(payer);
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const v = await post("/verify", { paymentPayload: { x402Version: 2, accepted: requirements, payload: p.payload }, paymentRequirements: requirements });
  assert(v.isValid === true && v.payer?.toLowerCase() === payer.toLowerCase(), JSON.stringify(v));
  assert((await usdcBalance(payer)) === before, "balance changed on verify");
});

await test("two payments from one account in flight at once both settle", async () => {
  const before = await usdcBalance(merchant);
  const [a, b] = await Promise.all([payingFetch(url), payingFetch(url)]);
  assert(a.status === 200 && b.status === 200, `statuses ${a.status}, ${b.status}`);
  const received = (await usdcBalance(merchant)) - before;
  assert(received === 2n * PRICE, `merchant received ${received}, expected ${2n * PRICE}`);
});

await test("settle timeout, then a retry of the same payload, produces exactly one transfer", async () => {
  const before = await usdcBalance(merchant);
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const payload = { x402Version: 2, accepted: requirements, payload: p.payload };
  // The same store as the facilitator: a timed-out settle leaves a claim that the retry relies on.
  const impatient = new IncentivUserOpFacilitatorScheme({ store, settleTimeoutMs: 1, pollIntervalMs: 1 });
  const first = await impatient.settle(payload, requirements);
  assert(!first.success && first.errorReason === "settle_timeout", JSON.stringify(first));
  const second = await post("/settle", { paymentPayload: payload, paymentRequirements: requirements });
  assert(second.success === true, JSON.stringify(second));
  const again = await post("/settle", { paymentPayload: payload, paymentRequirements: requirements });
  assert(again.success === false && again.errorReason === "already_settled", `a repeated settle must not succeed again: ${JSON.stringify(again)}`);
  const received = (await usdcBalance(merchant)) - before;
  assert(received === PRICE, `merchant received ${received}, expected exactly ${PRICE}`);
});

await test("after the deadline, a payment that executed is reported once, and only by the facilitator that submitted it", async () => {
  const before = await usdcBalance(merchant);
  const p = await clientScheme.createPaymentPayload(2, requirements);
  const payload = { x402Version: 2, accepted: requirements, payload: p.payload };
  const hash = (p.payload as { userOpHash: Hex }).userOpHash;
  const first = await new IncentivUserOpFacilitatorScheme({ store, settleTimeoutMs: 1, pollIntervalMs: 1 }).settle(payload, requirements);
  assert(first.errorReason === "settle_timeout", JSON.stringify(first));
  for (let i = 0; i < 60 && !(await getOpReceipt(chain, hash).catch(() => undefined)); i++) await new Promise((r) => setTimeout(r, 2000));
  const later = () => Date.now() + 10 * 60_000;
  const stranger = await new IncentivUserOpFacilitatorScheme({ now: later }).settle(payload, requirements);
  assert(!stranger.success && stranger.errorReason === "already_settled", `without the claim: ${JSON.stringify(stranger)}`);
  const claimant = new IncentivUserOpFacilitatorScheme({ store, now: later });
  const settled = await claimant.settle(payload, requirements);
  assert(settled.success === true, `the claimant past the deadline: ${JSON.stringify(settled)}`);
  const again = await claimant.settle(payload, requirements);
  assert(!again.success && again.errorReason === "already_settled", JSON.stringify(again));
  assert((await usdcBalance(merchant)) - before === PRICE, "merchant did not receive exactly one payment");
});

servers.forEach((s) => s.close());
const payerEnd = await usdcBalance(payer);
console.log(`\n${results.length - failures}/${results.length} passed. Payer spent ${formatUnits(payerStart - payerEnd, 6)} USDC in total.`);
process.exit(failures ? 1 : 0);
