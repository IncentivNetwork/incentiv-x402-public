import { getAddress, isAddressEqual, toHex, type Address, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import type { Network, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { accountFactoryAbi } from "../abi.js";
import { MAINNET, NETWORK, SCHEME, USDC_DECIMALS, ZERO32, type IncentivConfig } from "../constants.js";
import { checkPaysRequirements, decodePaymentOp, PaymentError } from "../decode.js";
import { makeChain, opToWire, preparePayment, requiredPrefund, signUserOp, type Chain } from "../userop.js";

export interface IncentivPayer {
  /** The owner EOA that controls the smart account. */
  owner: { address: Address; signMessage(args: { message: { raw: Hex } }): Promise<Hex> };
  /** CREATE2 salt the account was derived with. Default 0. */
  salt?: bigint;
  /** "token" (default) pays gas in USDC through the paymaster; "native" pays it in CENT from the account's deposit and balance. */
  gas?: "token" | "native";
  /**
   * The most USDC (atomic units, 6 decimals) this payer pays the paymaster for gas on one payment, with `gas: "token"`.
   * The fee is computed from the bundler's gas estimates, the RPC's gas price and the pool's quote, and none of
   * those are trusted to set it alone. Default 0.25 USDC; a payment cost about 0.03 USDC of gas in November 2026.
   */
  maxGasFee?: bigint;
  /**
   * The most CENT (wei) one payment may reserve for gas with `gas: "native"`: the gas limits times the fee cap,
   * which the EntryPoint can charge in full. Default 100 CENT; a payment needed about 20 to 30 at a base fee of
   * 37,000 gwei in November 2026. Unused gas is mostly refunded, but not all of it.
   */
  maxNativeGasCost?: bigint;
  /** Override the RPC and contract set; mainnet by default. */
  config?: IncentivConfig;
}

/** Default `maxGasFee`: 0.25 USDC. */
export const DEFAULT_MAX_GAS_FEE = 250_000n;
/** Default `maxNativeGasCost`: 100 CENT. */
export const DEFAULT_MAX_NATIVE_GAS_COST = 100n * 10n ** 18n;

/** What goes in `PaymentPayload.payload` for an `incentiv-userop` payment. */
export interface UserOpPaymentPayload {
  userOperation: Record<string, string>;
  userOpHash: Hex;
  paymentId: Hex;
  /** Unix seconds after which the facilitator refuses the payment. */
  validUntil: number;
}

/** Client side of `incentiv-userop`: builds, checks and signs the payment operation. */
export class IncentivUserOpClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  private readonly chain: Chain;
  private readonly cfg: IncentivConfig;

  constructor(private readonly payer: IncentivPayer) {
    this.cfg = payer.config ?? MAINNET;
    this.chain = makeChain(this.cfg);
  }

  /** Lets the stock spend controls recognise Incentiv USDC as a known asset. */
  findDefaultAsset = (asset: string, network: Network) =>
    network === NETWORK && asset.toLowerCase() === this.cfg.usdc.toLowerCase()
      ? { asset: this.cfg.usdc, decimals: USDC_DECIMALS, symbol: "USDC" }
      : undefined;

  /** The smart account this payer pays from. */
  async account(): Promise<Address> {
    return this.chain.client.readContract({
      address: this.cfg.accountFactory,
      abi: accountFactoryAbi,
      functionName: "getAddress",
      args: [this.payer.owner.address, [ZERO32, ZERO32], this.payer.salt ?? 0n],
    });
  }

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    if (x402Version !== 2) throw new Error(`incentiv-userop needs x402 v2, got v${x402Version}`);
    if (requirements.scheme !== SCHEME || requirements.network !== NETWORK) {
      throw new Error(`Cannot pay ${requirements.scheme} on ${requirements.network}`);
    }
    const entryPoint = requirements.extra?.entryPoint;
    if (typeof entryPoint !== "string" || !isAddressEqual(entryPoint as Address, this.cfg.entryPoint)) {
      throw new Error("The 402 names an EntryPoint this client does not trust");
    }
    const timeout = requirements.maxTimeoutSeconds;
    if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("The 402 has no usable maxTimeoutSeconds");

    const paymentId = toHex(randomBytes(32));
    const validUntil = Math.floor(Date.now() / 1000) + timeout;
    const account = await this.account();
    const prepared = await preparePayment(this.chain, {
      account,
      owner: this.payer.owner.address,
      salt: this.payer.salt,
      asset: getAddress(requirements.asset),
      payTo: getAddress(requirements.payTo),
      amount: BigInt(requirements.amount),
      paymentId,
      validUntil,
      gas: this.payer.gas,
    });

    // Never sign what was not asked for: decode what is about to be signed and compare it with the 402.
    let decoded;
    try {
      decoded = decodePaymentOp(prepared.op, this.cfg);
      checkPaysRequirements(decoded, requirements);
    } catch (e) {
      if (e instanceof PaymentError) throw new Error(`Refusing to sign: ${e.message}`);
      throw e;
    }
    // The gas transfer to the paymaster is not refunded, so a bad estimate or quote must not set it unchecked.
    const maxGasFee = this.payer.maxGasFee ?? DEFAULT_MAX_GAS_FEE;
    // Gas is paid in the payment token, and maxGasFee is in USDC, so the cap means nothing for another token.
    if (decoded.gasFee !== undefined && !isAddressEqual(decoded.token, this.cfg.usdc)) {
      throw new Error(`Refusing to sign: gas would be paid in ${decoded.token}, and maxGasFee is in USDC`);
    }
    // With gas in CENT, the gas limits come from the bundler and the fee cap from the RPC; neither sets the cost alone.
    const maxNative = this.payer.maxNativeGasCost ?? DEFAULT_MAX_NATIVE_GAS_COST;
    if (!prepared.op.paymaster && requiredPrefund(prepared.op) > maxNative) {
      throw new Error(`Refusing to sign: the operation may cost up to ${requiredPrefund(prepared.op)} wei of CENT for gas, above maxNativeGasCost (${maxNative})`);
    }
    if (decoded.gasFee !== undefined && decoded.gasFee > maxGasFee) {
      throw new Error(`Refusing to sign: the gas fee is ${decoded.gasFee} USDC atomic units, above maxGasFee (${maxGasFee})`);
    }

    const signed = await signUserOp(prepared.op, prepared.userOpHash, this.payer.owner);
    const payload: UserOpPaymentPayload = { userOperation: opToWire(signed), userOpHash: prepared.userOpHash, paymentId, validUntil };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}
