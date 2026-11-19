import assert from "node:assert/strict";
import test from "node:test";
import { concatHex, encodeFunctionData, pad, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { MAINNET } from "../src/constants.js";
import { checkPaysRequirements, decodePaymentOp, PaymentError } from "../src/decode.js";
import { IncentivUserOpScheme, toAtomic } from "../src/index.js";
import { accountAbi } from "../src/abi.js";
import { computeUserOpHash, encodeExecuteBatch, makeChain, paymentNonceKey, transferCall, type UserOp } from "../src/userop.js";

const merchant = "0x832166144c59Ed3524878441fa67F91615d2133B" as Address;
const payer = "0x044068B130fbAE15086BBD018601DAa6FAF0Adb5" as Address;
const usdc = MAINNET.usdc;

const op = (calls: ReturnType<typeof transferCall>[], extra: Partial<UserOp> = {}): UserOp => ({
  sender: payer,
  nonce: 1n << 64n,
  callData: encodeExecuteBatch(calls),
  callGasLimit: 100_000n,
  verificationGasLimit: 100_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 37_000_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymaster: MAINNET.paymaster,
  paymasterVerificationGasLimit: 300_000n,
  paymasterPostOpGasLimit: 50_000n,
  paymasterData: "0x",
  signature: "0x",
  ...extra,
});
const good = () => op([transferCall(usdc, MAINNET.paymaster, 26_000n), transferCall(usdc, merchant, 10_000n)]);
const requirement = { asset: usdc, payTo: merchant, amount: "10000" };

test("toAtomic converts prices without floating point", () => {
  assert.equal(toAtomic("$0.01", 6), "10000");
  assert.equal(toAtomic("0.000001", 6), "1");
  assert.equal(toAtomic(2, 6), "2000000");
  assert.equal(toAtomic("$1.50 USDC", 6), "1500000");
  assert.throws(() => toAtomic("0.0000001", 6), /decimal places/);
  assert.throws(() => toAtomic("0", 6), /greater than zero/);
  assert.throws(() => toAtomic("abc", 6), /Cannot read/);
});

test("parsePrice returns USDC on Incentiv and rejects other networks and assets", async () => {
  const s = new IncentivUserOpScheme();
  assert.deepEqual(await s.parsePrice("$0.05", "eip155:24101"), { asset: usdc, amount: "50000" });
  await assert.rejects(s.parsePrice("$0.05", "eip155:1"), /supports eip155:24101/);
  await assert.rejects(s.parsePrice({ asset: "0x0000000000000000000000000000000000000001", amount: "1" }, "eip155:24101"), /Only USDC/);
});

test("decode accepts the exact payment and reports the gas fee", () => {
  const d = decodePaymentOp(good(), MAINNET);
  assert.equal(d.amount, 10_000n);
  assert.equal(d.gasFee, 26_000n);
  checkPaysRequirements(d, requirement);
});

test("check refuses a wrong recipient, amount or asset with the matching reason", () => {
  const d = decodePaymentOp(good(), MAINNET);
  const reason = (req: object) => {
    try {
      checkPaysRequirements(d, { ...requirement, ...req });
    } catch (e) {
      return (e as PaymentError).reason;
    }
  };
  assert.equal(reason({ payTo: payer }), "payto_mismatch");
  assert.equal(reason({ amount: "10001" }), "amount_mismatch");
  assert.equal(reason({ asset: "0x0000000000000000000000000000000000000001" }), "asset_mismatch");
});

test("decode refuses extra calls, approvals, native value and a foreign paymaster", () => {
  const refused = (o: UserOp) => assert.throws(() => decodePaymentOp(o, MAINNET), PaymentError);
  refused(op([transferCall(usdc, MAINNET.paymaster, 26_000n), transferCall(usdc, merchant, 10_000n), transferCall(usdc, payer, 1n)]));
  refused(op([transferCall(usdc, merchant, 10_000n)])); // paymaster set but no gas transfer
  refused(op([transferCall(usdc, merchant, 1n), transferCall(usdc, merchant, 10_000n)])); // gas goes to the wrong place
  refused({ ...good(), paymaster: payer });
  refused({ ...good(), paymasterData: "0x01" });
  const approve = { to: usdc, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [merchant, 1n] }) };
  refused(op([transferCall(usdc, MAINNET.paymaster, 26_000n), approve]));
  refused(op([transferCall(usdc, MAINNET.paymaster, 26_000n), { ...transferCall(usdc, merchant, 10_000n), value: 1n }]));
  refused({ ...good(), callData: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [usdc, 0n, "0x"] }) });
  // Trailing bytes after a valid transfer must not slip through a lenient decoder.
  const padded = transferCall(usdc, merchant, 10_000n);
  refused(op([transferCall(usdc, MAINNET.paymaster, 26_000n), { ...padded, data: `${padded.data}00` as Hex }]));
});

test("without a paymaster the operation must be a single transfer", () => {
  const solo = { ...op([transferCall(usdc, merchant, 10_000n)]), paymaster: undefined };
  assert.equal(decodePaymentOp(solo, MAINNET).gasFee, undefined);
  assert.throws(() => decodePaymentOp({ ...solo, callData: good().callData }, MAINNET), PaymentError);
});

test("the nonce lane depends on both the payment id and the deadline", () => {
  const id = `0x${"11".repeat(32)}` as Hex;
  const key = paymentNonceKey(id, 1_800_000_000);
  assert.ok(key < 1n << 192n);
  assert.notEqual(key, paymentNonceKey(id, 1_800_000_001));
  assert.notEqual(key, paymentNonceKey(`0x${"22".repeat(32)}`, 1_800_000_000));
});

test("the local user operation hash equals the EntryPoint's on chain", async () => {
  const chain = makeChain();
  const o = op([transferCall(usdc, MAINNET.paymaster, 26_000n), transferCall(usdc, merchant, 10_000n)], {
    factory: MAINNET.accountFactory,
    factoryData: "0x1234",
  });
  const pack = (a: bigint, b: bigint): Hex => concatHex([pad(numberToHex(a), { size: 16 }), pad(numberToHex(b), { size: 16 })]);
  const abi = parseAbi([
    "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
    "function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)",
  ]);
  const onChain = await chain.client.readContract({
    address: MAINNET.entryPoint,
    abi,
    functionName: "getUserOpHash",
    args: [
      {
        sender: o.sender,
        nonce: o.nonce,
        initCode: concatHex([o.factory!, o.factoryData!]),
        callData: o.callData,
        accountGasLimits: pack(o.verificationGasLimit, o.callGasLimit),
        preVerificationGas: o.preVerificationGas,
        gasFees: pack(o.maxPriorityFeePerGas, o.maxFeePerGas),
        paymasterAndData: concatHex([o.paymaster!, pad(numberToHex(o.paymasterVerificationGasLimit!), { size: 16 }), pad(numberToHex(o.paymasterPostOpGasLimit!), { size: 16 })]),
        signature: "0x",
      },
    ],
  });
  assert.equal(computeUserOpHash(o, MAINNET.entryPoint, MAINNET.chainId), onChain);
});
