import { getAddress, type Address, type Hex, type TransactionSerializableEIP1559 } from "viem";
import type { Network, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { EOA_SCHEME, MAINNET, MAX_EOA_GAS, NETWORK, USDC_DECIMALS, type IncentivConfig } from "../constants.js";
import { checkPaysRequirements, PaymentError } from "../decode.js";
import { decodeEoaPayment, deadlineMarker } from "../eoa.js";
import { makeChain, transferCall, type Chain } from "../userop.js";

export interface IncentivEoaPayer {
  /** The paying wallet: a viem local account (private key) or anything that signs EIP-1559 transactions. */
  owner: { address: Address; signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex> };
  config?: IncentivConfig;
}

/** What goes in `PaymentPayload.payload` for an `incentiv-eoa-tx` payment. */
export interface EoaPaymentPayload {
  signedTransaction: Hex;
}

/** Client side of `incentiv-eoa-tx`: signs one USDC transfer from the payer's own address. */
export class IncentivEoaTxClientScheme implements SchemeNetworkClient {
  readonly scheme = EOA_SCHEME;
  private readonly chain: Chain;
  private readonly cfg: IncentivConfig;

  constructor(private readonly payer: IncentivEoaPayer) {
    this.cfg = payer.config ?? MAINNET;
    this.chain = makeChain(this.cfg);
  }

  findDefaultAsset = (asset: string, network: Network) =>
    network === NETWORK && asset.toLowerCase() === this.cfg.usdc.toLowerCase()
      ? { asset: this.cfg.usdc, decimals: USDC_DECIMALS, symbol: "USDC" }
      : undefined;

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    if (x402Version !== 2) throw new Error(`incentiv-eoa-tx needs x402 v2, got v${x402Version}`);
    if (requirements.scheme !== EOA_SCHEME || requirements.network !== NETWORK) {
      throw new Error(`Cannot pay ${requirements.scheme} on ${requirements.network}`);
    }
    if (requirements.asset.toLowerCase() !== this.cfg.usdc.toLowerCase()) throw new Error("Only USDC payments are supported");
    const timeout = requirements.maxTimeoutSeconds;
    if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("The 402 has no usable maxTimeoutSeconds");

    const from = this.payer.owner.address;
    const asset = getAddress(requirements.asset);
    const call = transferCall(asset, getAddress(requirements.payTo), BigInt(requirements.amount));
    const [nonce, pending, estimate, block] = await Promise.all([
      this.chain.client.getTransactionCount({ address: from, blockTag: "latest" }),
      this.chain.client.getTransactionCount({ address: from, blockTag: "pending" }),
      this.chain.client.estimateGas({ account: from, to: asset, data: call.data }),
      this.chain.client.getBlock(),
    ]);
    // The facilitator accepts only the next confirmed nonce, so a payment signed behind a pending transaction
    // would be refused as nonce_used. Say so now instead.
    if (pending !== nonce) {
      throw new Error(`${from} has ${pending - nonce} pending transaction(s); wait until they are mined before paying`);
    }
    const gas = (estimate * 120n) / 100n;
    if (gas > MAX_EOA_GAS) throw new Error(`The transfer needs ${gas} gas, above the ${MAX_EOA_GAS} the facilitator accepts`);
    const tip = 1_000_000_000n;
    const validUntil = Math.floor(Date.now() / 1000) + timeout;

    const signedTransaction = await this.payer.owner.signTransaction({
      type: "eip1559",
      chainId: this.cfg.chainId,
      to: asset,
      value: 0n,
      data: call.data,
      nonce,
      gas,
      maxFeePerGas: ((block.baseFeePerGas ?? 12_600_000_000_000n) * 13n) / 10n + tip,
      maxPriorityFeePerGas: tip,
      accessList: [{ address: deadlineMarker(validUntil), storageKeys: [] }],
    });

    // Never sign what was not asked for: decode what was signed and compare it with the 402.
    try {
      const decoded = await decodeEoaPayment(signedTransaction, this.cfg.chainId);
      checkPaysRequirements(decoded, requirements);
    } catch (e) {
      if (e instanceof PaymentError) throw new Error(`Refusing to send: ${e.message}`);
      throw e;
    }
    const payload: EoaPaymentPayload = { signedTransaction };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}
