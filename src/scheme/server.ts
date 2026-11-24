import type { AssetAmount, Network, PaymentRequirements, Price, SchemeNetworkServer, SupportedKind } from "@x402/core/types";
import { MAINNET, MAX_TIMEOUT_SECONDS, NETWORK, SCHEME, USDC_DECIMALS, type IncentivConfig } from "../constants.js";

/** Convert a decimal string such as "0.05" to atomic units without floating point. */
export function toAtomic(value: string | number, decimals: number): string {
  const text = String(value).trim().replace(/^\$/, "").replace(/\s*USDC$/i, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`Cannot read "${value}" as a price`);
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimal places`);
  const atomic = BigInt(m[1]! + fraction.padEnd(decimals, "0"));
  if (atomic <= 0n) throw new Error("A price must be greater than zero");
  return atomic.toString();
}

/**
 * Server side of `incentiv-userop`: turns prices into USDC amounts on Incentiv and
 * advertises the EntryPoint the payer's operation must target.
 */
export class IncentivUserOpScheme implements SchemeNetworkServer {
  readonly scheme: string = SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = { default: { supported: ["authorization", "upfront"], default: "authorization" } } as const;

  constructor(private readonly cfg: IncentivConfig = MAINNET) {}

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (network !== NETWORK) throw new Error(`incentiv-userop supports ${NETWORK}, not ${network}`);
    if (typeof price === "object") {
      if (price.asset.toLowerCase() !== this.cfg.usdc.toLowerCase()) throw new Error("Only USDC is supported on Incentiv");
      return price;
    }
    return { asset: this.cfg.usdc, amount: toAtomic(price, USDC_DECIMALS) };
  }

  getAssetDecimals(asset: string): number | undefined {
    return asset.toLowerCase() === this.cfg.usdc.toLowerCase() ? USDC_DECIMALS : undefined;
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    return {
      ...requirements,
      maxTimeoutSeconds: Math.min(requirements.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS),
      extra: { ...requirements.extra, entryPoint: this.cfg.entryPoint },
    };
  }
}
