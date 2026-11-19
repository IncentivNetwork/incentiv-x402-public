import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IncentivUserOpClientScheme } from "../src/scheme/client.js";

// Throwaway keys for the mainnet e2e test. They go in a gitignored file and are never printed.
const file = ".env.e2e";
if (existsSync(file)) {
  console.error(`${file} already exists; delete it first to generate new keys.`);
  process.exit(1);
}
const payerKey = generatePrivateKey();
const merchantKey = generatePrivateKey();
writeFileSync(file, `E2E_PAYER_KEY=${payerKey}\nE2E_MERCHANT_KEY=${merchantKey}\n`);
chmodSync(file, 0o600);

const owner = privateKeyToAccount(payerKey);
const payerAccount = await new IncentivUserOpClientScheme({ owner }).account();
console.log(`Keys written to ${file} (not shown).`);
console.log(`Payer smart account (INCENTIV MAINNET ONLY): ${payerAccount}`);
console.log("  This address exists only on Incentiv. Never send funds to it on Ethereum or any other chain.");
console.log("  To bridge in, set the recipient to it in the Incentiv Bridge. Check with: npm run where");
console.log(`Merchant address (receives payments):  ${privateKeyToAccount(merchantKey).address}`);
