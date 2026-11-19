import type { Address, Hex } from "viem";
import type { Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import { erc20Abi, TRANSFER_GATE_REASONS, transferGateAbi } from "../abi.js";
import { EOA_SCHEME, MAINNET, MAX_TIMEOUT_SECONDS, NETWORK, type IncentivConfig } from "../constants.js";
import { checkPaysRequirements, PaymentError } from "../decode.js";
import { decodeEoaPayment, type DecodedEoaPayment } from "../eoa.js";
import { MemoryStore, type SettledStore } from "../facilitator/store.js";
import { makeChain, type Chain } from "../userop.js";
import type { EoaPaymentPayload } from "./client-eoa.js";
import type { FacilitatorOptions } from "./facilitator.js";

const CLOCK_SKEW_SECONDS = 5;

/** Facilitator side of `incentiv-eoa-tx`: verifies a signed USDC transfer and broadcasts it through the RPC. */
export class IncentivEoaTxFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = EOA_SCHEME;
  readonly caipFamily = NETWORK;
  private readonly cfg: IncentivConfig;
  private readonly chain: Chain;
  private readonly store: SettledStore;
  private readonly settleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<SettleResponse>>();
  /** Payers with a settlement in progress: an EOA has one nonce sequence, so one payment at a time. */
  private readonly busy = new Set<string>();

  constructor(options: FacilitatorOptions = {}) {
    this.cfg = options.config ?? MAINNET;
    this.chain = makeChain(this.cfg);
    this.store = options.store ?? new MemoryStore();
    this.settleTimeoutMs = options.settleTimeoutMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.now = options.now ?? (() => Date.now());
  }

  getExtra(_network: Network) {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [];
  }

  // --- verify ---------------------------------------------------------------

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const d = await this.parse(payload, requirements);
      await this.checkChain(d, { rejectSettled: true, rejectBusy: true });
      return { isValid: true, payer: d.sender };
    } catch (e) {
      return this.invalid(e);
    }
  }

  private invalid(e: unknown): VerifyResponse {
    if (e instanceof PaymentError) return { isValid: false, invalidReason: e.reason, invalidMessage: e.message };
    return { isValid: false, invalidReason: "unexpected_verify_error", invalidMessage: e instanceof Error ? e.message : String(e) };
  }

  /** Checks that need no chain access: scheme, shape, deadline and the quoted payment. */
  private async parse(payload: PaymentPayload, req: PaymentRequirements): Promise<DecodedEoaPayment> {
    if (payload.x402Version !== 2) throw new PaymentError("invalid_x402_version", "x402 version must be 2");
    if (req.scheme !== EOA_SCHEME || payload.accepted?.scheme !== EOA_SCHEME) throw new PaymentError("invalid_scheme", `scheme must be ${EOA_SCHEME}`);
    if (req.network !== NETWORK || payload.accepted?.network !== NETWORK) throw new PaymentError("invalid_network", `network must be ${NETWORK}`);
    for (const k of ["asset", "payTo", "amount"] as const) {
      if (String(payload.accepted[k]).toLowerCase() !== String(req[k]).toLowerCase()) {
        throw new PaymentError("invalid_payment_requirements", `accepted.${k} differs from the requirements`);
      }
    }
    const d = await decodeEoaPayment((payload.payload as Partial<EoaPaymentPayload>)?.signedTransaction, this.cfg.chainId);

    const nowSeconds = Math.floor(this.now() / 1000);
    if (d.validUntil <= nowSeconds) throw new PaymentError("payment_expired", "validUntil has passed");
    if (d.validUntil > nowSeconds + Math.min(req.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS) + CLOCK_SKEW_SECONDS) {
      throw new PaymentError("invalid_payment_requirements", "validUntil is further away than maxTimeoutSeconds");
    }
    checkPaysRequirements(d, req);
    return d;
  }

  /** Checks against the chain: replay, one payment in flight, nonce, funds, simulation and TransferGate. */
  private async checkChain(d: DecodedEoaPayment, opts: { rejectSettled: boolean; rejectBusy: boolean }): Promise<void> {
    if (opts.rejectSettled && this.store.get(d.txHash)) throw new PaymentError("already_settled", "this transaction was already settled");
    if (opts.rejectBusy && this.busy.has(d.sender.toLowerCase())) throw new PaymentError("payer_busy", "another payment from this payer is being settled");

    const count = await this.chain.client.getTransactionCount({ address: d.sender, blockTag: "latest" });
    if (count !== d.nonce) throw new PaymentError("nonce_used", `account nonce is ${count}, transaction uses ${d.nonce}`);

    const [usdc, cent] = await Promise.all([
      this.chain.client.readContract({ address: d.token, abi: erc20Abi, functionName: "balanceOf", args: [d.sender] }),
      this.chain.client.getBalance({ address: d.sender }),
    ]);
    if (usdc < d.amount) throw new PaymentError("insufficient_funds", `USDC balance ${usdc} is below ${d.amount}`);
    if (cent < d.gas * d.maxFeePerGas) throw new PaymentError("insufficient_funds", `CENT balance ${cent} does not cover gas ${d.gas * d.maxFeePerGas}`);

    try {
      await this.chain.client.call({ account: d.sender, to: d.token, data: d.data, gas: d.gas });
    } catch (e) {
      throw new PaymentError("simulation_failed", e instanceof Error ? e.message.split("\n")[0]! : String(e));
    }
    let reject: number;
    try {
      const r = await this.chain.client.readContract({
        address: this.cfg.transferGate,
        abi: transferGateAbi,
        functionName: "checkApproval",
        args: [d.token, 0n, d.data],
        account: d.sender,
      });
      reject = Number(r.reject);
    } catch (e) {
      throw new PaymentError("transfer_gate_unavailable", `TransferGate check failed: ${e instanceof Error ? e.message : e}`);
    }
    if (reject !== 0) {
      const name = TRANSFER_GATE_REASONS[reject] ?? `UNKNOWN(${reject})`;
      throw new PaymentError(name === "PENDING" ? "transfer_gate_pending" : "transfer_gate_blocked", `TransferGate: ${name}`);
    }
  }

  // --- settle ---------------------------------------------------------------

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    let d: DecodedEoaPayment;
    try {
      d = await this.parse(payload, requirements);
    } catch (e) {
      const v = this.invalid(e);
      return this.fail(v.invalidReason ?? "unexpected_settle_error", v.invalidMessage ?? "");
    }
    const key = d.txHash.toLowerCase();
    // One settlement, one claimant. A payment that is final, or being settled for another request,
    // is never reported as a success again, or one payment could serve many requests.
    if (this.store.get(key)) return this.fail("already_settled", "this transaction was already settled", d.sender);
    if (this.inflight.has(key)) return this.fail("already_settling", "another request is settling this payment", d.sender);
    const run = this.settleOnce(d).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private fail(reason: string, message: string, payer?: Address, transaction = ""): SettleResponse {
    return { success: false, errorReason: reason, errorMessage: message, payer, transaction, network: NETWORK };
  }

  private async receipt(hash: Hex) {
    try {
      return await this.chain.client.getTransactionReceipt({ hash });
    } catch {
      return undefined;
    }
  }

  private async settleOnce(d: DecodedEoaPayment): Promise<SettleResponse> {
    const sender = d.sender.toLowerCase();
    const outcome = (status: "success" | "reverted", hash: Hex): SettleResponse => {
      const r =
        status === "success"
          ? ({ success: true, payer: d.sender, transaction: hash, network: NETWORK, amount: d.amount.toString() } as SettleResponse)
          : this.fail("tx_reverted", "the transfer reverted on chain", d.sender, hash);
      this.store.set(d.txHash, r);
      return r;
    };

    // It may already be on chain from an attempt that timed out. The hash commits to the whole transaction.
    let receipt = await this.receipt(d.txHash);
    if (!receipt) {
      if (this.busy.has(sender)) return this.fail("payer_busy", "another payment from this payer is being settled", d.sender);
      this.busy.add(sender);
      try {
        try {
          await this.checkChain(d, { rejectSettled: false, rejectBusy: false });
        } catch (e) {
          const v = this.invalid(e);
          return this.fail(v.invalidReason ?? "unexpected_settle_error", v.invalidMessage ?? "", d.sender);
        }
        try {
          await this.chain.client.sendRawTransaction({ serializedTransaction: d.raw as `0x02${string}` });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (!/already known|known transaction|already in/i.test(message)) return this.fail("tx_rejected", message.split("\n")[0]!, d.sender);
        }
        const deadline = this.now() + this.settleTimeoutMs;
        while (!receipt && this.now() < deadline) {
          await new Promise((r) => setTimeout(r, this.pollIntervalMs));
          receipt = await this.receipt(d.txHash);
        }
      } finally {
        this.busy.delete(sender);
      }
    }
    if (!receipt) return this.fail("settle_timeout", "no receipt within the settle window; resend the same payload", d.sender);
    return outcome(receipt.status, d.txHash);
  }
}

