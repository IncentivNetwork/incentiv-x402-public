import { readFileSync } from "node:fs";
import { formatEther, formatUnits, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IncentivUserOpClientScheme, makeChain, MAINNET } from "../src/index.js";
import { erc20Abi } from "../src/abi.js";
import { transferCall } from "../src/userop.js";

// Moves a small amount of USDC from the EOA to the smart-account payer, both on Incentiv. Gas is paid in CENT by the EOA.
// Usage: npm run fund-smart-account [-- <amount in USDC>] [--dry]
const dry = process.argv.includes("--dry");
const amountArg = process.argv.slice(2).find((a) => /^\d+(\.\d+)?$/.test(a)) ?? "0.5";
const amount = parseUnits(amountArg, 6);
if (amount <= 0n || amount > parseUnits("2", 6)) throw new Error("The amount must be between 0 and 2 USDC.");

const env = Object.fromEntries(readFileSync(".env.e2e", "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
const owner = privateKeyToAccount(env.E2E_PAYER_KEY as Hex);
const chain = makeChain();
const smartAccount = await new IncentivUserOpClientScheme({ owner }).account();

const [usdc, cent] = await Promise.all([
  chain.client.readContract({ address: MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] }),
  chain.client.getBalance({ address: owner.address }),
]);
if (usdc < amount) throw new Error(`The EOA holds ${formatUnits(usdc, 6)} USDC, less than ${amountArg}.`);

const call = transferCall(MAINNET.usdc, smartAccount, amount);
const [nonce, gasEstimate, block] = await Promise.all([
  chain.client.getTransactionCount({ address: owner.address, blockTag: "pending" }),
  chain.client.estimateGas({ account: owner.address, to: MAINNET.usdc, data: call.data }),
  chain.client.getBlock(),
]);
const gas = (gasEstimate * 120n) / 100n;
const maxFeePerGas = ((block.baseFeePerGas ?? 12_600_000_000_000n) * 13n) / 10n + 1_000_000_000n;
if (cent < gas * maxFeePerGas) throw new Error(`The EOA needs about ${formatEther(gas * maxFeePerGas)} CENT for gas and holds ${formatEther(cent)}.`);

console.log(`from EOA          ${owner.address}  (${formatUnits(usdc, 6)} USDC, ${formatEther(cent)} CENT)`);
console.log(`to smart account  ${smartAccount}  (Incentiv only)`);
console.log(`sending ${amountArg} USDC; gas about ${formatEther(gasEstimate * maxFeePerGas)} CENT`);
if (dry) {
  console.log("dry run: nothing sent");
  process.exit(0);
}

const signed = await owner.signTransaction({
  type: "eip1559",
  chainId: MAINNET.chainId,
  to: MAINNET.usdc,
  value: 0n,
  data: call.data,
  nonce,
  gas,
  maxFeePerGas,
  maxPriorityFeePerGas: 1_000_000_000n,
});
const hash = await chain.client.sendRawTransaction({ serializedTransaction: signed });
console.log(`submitted ${hash}; waiting for the receipt...`);
const receipt = await chain.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
console.log(receipt.status === "success" ? "done" : `FAILED on chain`);
const after = await chain.client.readContract({ address: MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [smartAccount] });
console.log(`smart account now holds ${formatUnits(after, 6)} USDC`);
process.exit(receipt.status === "success" ? 0 : 1);
