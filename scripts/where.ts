import { readFileSync } from "node:fs";
import { createPublicClient, formatEther, formatUnits, http, parseAbi, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { IncentivUserOpClientScheme, makeChain, MAINNET } from "../src/index.js";
import { erc20Abi } from "../src/abi.js";

// Shows where the test funds are, on both chains, so nothing is sent to the wrong place.
const env = Object.fromEntries(readFileSync(".env.e2e", "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
const owner = privateKeyToAccount(env.E2E_PAYER_KEY as Hex);
const merchant = privateKeyToAccount(env.E2E_MERCHANT_KEY as Hex).address;
const payer = await new IncentivUserOpClientScheme({ owner }).account();

const incentiv = makeChain();
const ethereum = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
const ETH_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const bal = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const row = async (label: string, address: Address) => {
  const [iUsdc, iCent, eUsdc, eEth] = await Promise.all([
    incentiv.client.readContract({ address: MAINNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    incentiv.client.getBalance({ address }),
    ethereum.readContract({ address: ETH_USDC, abi: bal, functionName: "balanceOf", args: [address] }),
    ethereum.getBalance({ address }),
  ]);
  console.log(`${label}\n  ${address}\n  Incentiv:  ${formatUnits(iUsdc, 6)} USDC, ${formatEther(iCent)} CENT\n  Ethereum:  ${formatUnits(eUsdc, 6)} USDC, ${formatEther(eEth)} ETH`);
};

await row("PAYER smart account (Incentiv only: never send funds to it on Ethereum)", payer);
await row("EOA PAYER (same address on every chain: fund it on Incentiv for `npm run e2e`)", owner.address);
await row("MERCHANT (receives payments)", merchant);
if ((await ethereum.readContract({ address: ETH_USDC, abi: bal, functionName: "balanceOf", args: [payer] })) > 0n) {
  console.log("\nWARNING: USDC sits at the payer smart-account address on Ethereum. That address has no contract there, so those funds are likely unrecoverable.");
}
