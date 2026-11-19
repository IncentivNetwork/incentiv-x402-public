import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "../src/abi.js";
import { MAINNET } from "../src/constants.js";
import { checkPaysRequirements, PaymentError } from "../src/decode.js";
import { deadlineMarker, decodeEoaPayment } from "../src/eoa.js";
import { IncentivEoaTxScheme } from "../src/index.js";

const merchant = "0x832166144c59Ed3524878441fa67F91615d2133B";
const owner = privateKeyToAccount(generatePrivateKey());
const usdc = MAINNET.usdc;
const transferData = (to: string, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, amount] });

async function sign(over: Record<string, unknown> = {}): Promise<Hex> {
  return owner.signTransaction({
    type: "eip1559",
    chainId: MAINNET.chainId,
    to: usdc,
    value: 0n,
    data: transferData(merchant, 10_000n),
    nonce: 7,
    gas: 60_000n,
    maxFeePerGas: 48_000_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    accessList: [{ address: deadlineMarker(1_800_000_000), storageKeys: [] }],
    ...over,
  } as never);
}
const reason = async (raw: unknown) => {
  try {
    await decodeEoaPayment(raw, MAINNET.chainId);
  } catch (e) {
    return (e as PaymentError).reason;
  }
};

test("the deadline marker round-trips and is a valid address", () => {
  const m = deadlineMarker(1_800_000_000);
  assert.match(m, /^0x78343032[0-9a-f]{16}0{16}$/);
  assert.equal(m.length, 42);
});

test("decode reads the sender, payment and deadline from a signed transaction", async () => {
  const d = await decodeEoaPayment(await sign(), MAINNET.chainId);
  assert.equal(d.sender, owner.address);
  assert.equal(d.token, usdc);
  assert.equal(d.to, merchant);
  assert.equal(d.amount, 10_000n);
  assert.equal(d.validUntil, 1_800_000_000);
  assert.equal(d.nonce, 7);
  assert.match(d.txHash, /^0x[0-9a-f]{64}$/);
  checkPaysRequirements(d, { asset: usdc, payTo: merchant, amount: "10000" });
});

test("check refuses a wrong recipient, amount or asset", async () => {
  const d = await decodeEoaPayment(await sign(), MAINNET.chainId);
  const why = (req: object) => {
    try {
      checkPaysRequirements(d, { asset: usdc, payTo: merchant, amount: "10000", ...req });
    } catch (e) {
      return (e as PaymentError).reason;
    }
  };
  assert.equal(why({ payTo: owner.address }), "payto_mismatch");
  assert.equal(why({ amount: "10001" }), "amount_mismatch");
  assert.equal(why({ asset: owner.address }), "asset_mismatch");
});

test("decode refuses what is not exactly one USDC transfer with a deadline", async () => {
  assert.equal(await reason("0x"), "invalid_payload");
  assert.equal(await reason(undefined), "invalid_payload");
  assert.equal(await reason(await sign({ chainId: 1 })), "invalid_payload");
  assert.equal(await reason(await sign({ value: 1n })), "invalid_payload");
  assert.equal(await reason(await sign({ gas: 500_000n })), "invalid_payload");
  assert.equal(await reason(await sign({ accessList: [] })), "invalid_payload");
  assert.equal(await reason(await sign({ accessList: [{ address: merchant, storageKeys: [] }] })), "invalid_payload");
  assert.equal(await reason(await sign({ accessList: [{ address: deadlineMarker(1), storageKeys: [`0x${"00".repeat(32)}`] }] })), "invalid_payload");
  assert.equal(await reason(await sign({ data: `${transferData(merchant, 1n)}00` })), "invalid_payload");
  assert.equal(await reason(await sign({ data: encodeFunctionData({ abi: [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" }], functionName: "approve", args: [merchant, 1n] }) })), "invalid_payload");
});

test("a tampered signature recovers a different sender, so the payer cannot be spoofed", async () => {
  const raw = await sign();
  const flipped = `${raw.slice(0, -2)}${raw.endsWith("00") ? "01" : "00"}` as Hex;
  const d = await decodeEoaPayment(flipped, MAINNET.chainId).catch((e: PaymentError) => e);
  assert.ok(d instanceof PaymentError || d.sender !== owner.address);
});

test("the EOA server scheme prices in USDC and adds no extra fields", async () => {
  const s = new IncentivEoaTxScheme();
  assert.equal(s.scheme, "incentiv-eoa-tx");
  assert.deepEqual(await s.parsePrice("$0.01", "eip155:24101"), { asset: usdc, amount: "10000" });
  const enhanced = await s.enhancePaymentRequirements(
    { scheme: s.scheme, network: "eip155:24101", asset: usdc, amount: "10000", payTo: merchant, maxTimeoutSeconds: 900, extra: {} },
    { x402Version: 2, scheme: s.scheme, network: "eip155:24101" },
    [],
  );
  assert.equal(enhanced.maxTimeoutSeconds, 300);
  assert.deepEqual(enhanced.extra, {});
});
