import type { Address, Hex } from "viem";
import type { Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import { erc20Abi, TRANSFER_GATE_REASONS, transferGateAbi } from "../abi.js";
import { EOA_SCHEME, MAINNET, MAX_TIMEOUT_SECONDS, NETWORK, type IncentivConfig } from "../constants.js";
import { checkPaysRequirements, checkUsdcPositive, logMessage, logToStderr, PaymentError, publicMessage } from "../decode.js";
import { decodeEoaPayment, type DecodedEoaPayment } from "../eoa.js";
import { MemoryStore, type SettledStore } from "../facilitator/store.js";
import { makeChain, nonceRefusal, refusedOnSubmit, SettleDeadlineError, withDeadline, type Chain } from "../userop.js";
import type { EoaPaymentPayload } from "./client-eoa.js";
import type { FacilitatorOptions } from "./facilitator.js";
import type { TransactionReceipt } from "viem";
import { hasPaymentTransfer, TRANSFER_MISSING } from "../facilitator/settlement.js";

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
  private readonly log: (line: Record<string, unknown>) => void;
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
    this.log = options.log ?? logToStderr;
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
      if (this.store.get(d.txHash)) throw new PaymentError("already_settled", "this transaction was already settled");
      // A payment this facilitator submitted that executed, but whose settle timed out or could not be recorded:
      // the chain no longer matches the payload (its nonce is used), so it is valid as is, and the settle that
      // follows records it and reports it once. That is how a verify-first merchant recovers it.
      const claimed = this.store.isClaimed(d.txHash);
      const receipt = claimed ? await this.receipt(d.txHash) : undefined;
      if (receipt?.status === "success") {
        if (!hasPaymentTransfer(receipt.logs, d.sender, d)) throw new PaymentError("payment_transfer_missing", TRANSFER_MISSING);
        return { isValid: true, payer: d.sender };
      }
      try {
        this.checkDeadline(d, requirements);
        await this.checkChain(d, { rejectSettled: true, rejectBusy: true });
        return { isValid: true, payer: d.sender };
      } catch (e) {
        // Submitted here before and it may still land (pending past its deadline, or mined but not yet visible):
        // valid, so a verify-first merchant settles again, and that settle waits for the receipt without
        // submitting it again.
        if (claimed && !receipt && e instanceof PaymentError && (await this.mayStillLand(d, e.reason, this.now() + this.settleTimeoutMs))) {
          return { isValid: true, payer: d.sender };
        }
        throw e;
      }
    } catch (e) {
      return this.invalid(e);
    }
  }

  private invalid(e: unknown, unexpected = "unexpected_verify_error"): VerifyResponse {
    if (e instanceof PaymentError) {
      // The client gets the sanitized message; the original error behind it goes to the log.
      if (e.detail !== undefined) this.log({ event: "payment_error", reason: e.reason, error: logMessage(e.detail) });
      return { isValid: false, invalidReason: e.reason, invalidMessage: e.message };
    }
    // An unexpected error can carry internals (RPC URL, request body); the client gets a generic message.
    this.log({ event: "unexpected_error", error: logMessage(e) });
    return { isValid: false, invalidReason: unexpected, invalidMessage: "internal error" };
  }

  /** The facilitator enforces the deadline; the chain has no validity window. */
  private checkDeadline(d: DecodedEoaPayment, req: PaymentRequirements): void {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (d.validUntil <= nowSeconds) throw new PaymentError("payment_expired", "validUntil has passed");
    if (d.validUntil > nowSeconds + Math.min(req.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS) + CLOCK_SKEW_SECONDS) {
      throw new PaymentError("invalid_payment_requirements", "validUntil is further away than maxTimeoutSeconds");
    }
  }

  /** Checks that need no chain access: scheme, shape and the quoted payment. The deadline is checked separately. */
  private async parse(payload: PaymentPayload, req: PaymentRequirements): Promise<DecodedEoaPayment> {
    if (payload.x402Version !== 2) throw new PaymentError("invalid_x402_version", "x402 version must be 2");
    if (req.scheme !== EOA_SCHEME || payload.accepted?.scheme !== EOA_SCHEME) throw new PaymentError("invalid_scheme", `scheme must be ${EOA_SCHEME}`);
    if (req.network !== NETWORK || payload.accepted?.network !== NETWORK) throw new PaymentError("invalid_network", `network must be ${NETWORK}`);
    for (const k of ["asset", "payTo", "amount"] as const) {
      if (String(payload.accepted[k]).toLowerCase() !== String(req[k]).toLowerCase()) {
        throw new PaymentError("invalid_payment_requirements", `accepted.${k} differs from the requirements`);
      }
    }
    if (!Number.isInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) {
      throw new PaymentError("invalid_payment_requirements", "maxTimeoutSeconds must be a positive integer");
    }
    checkUsdcPositive(req, this.cfg);
    const d = await decodeEoaPayment((payload.payload as Partial<EoaPaymentPayload>)?.signedTransaction, this.cfg.chainId);
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
      throw new PaymentError("simulation_failed", publicMessage(e), e);
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
      throw new PaymentError("transfer_gate_unavailable", `TransferGate check failed: ${publicMessage(e)}`, e);
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
      const v = this.invalid(e, "unexpected_settle_error");
      return this.fail(v.invalidReason ?? "unexpected_settle_error", v.invalidMessage ?? "");
    }
    const key = d.txHash.toLowerCase();
    // One settlement, one claimant. A payment that is final, or being settled for another request,
    // is never reported as a success again, or one payment could serve many requests.
    if (this.store.get(key)) return this.fail("already_settled", "this transaction was already settled", d.sender);
    if (this.inflight.has(key)) return this.fail("already_settling", "another request is settling this payment", d.sender);
    const run = this.settleOnce(d, requirements).finally(() => this.inflight.delete(key));
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

  /**
   * Whether some transaction with this payment's nonce is on chain or in the node's mempool; undefined if the RPC
   * cannot say. Pending counts: a transaction the node accepted may land.
   */
  private async nonceUsed(d: DecodedEoaPayment): Promise<boolean | undefined> {
    try {
      return (await this.chain.client.getTransactionCount({ address: d.sender, blockTag: "pending" })) > d.nonce;
    } catch {
      return undefined;
    }
  }


  /**
   * Runs a chain read within the settle deadline: undefined if it fails or has not answered by then. Every read in
   * a settle goes through this, so a settle never runs past its window.
   */
  private async within<T>(deadline: number, read: () => Promise<T>): Promise<T | undefined> {
    const left = deadline - this.now();
    if (left <= 0) return undefined;
    return withDeadline(read(), left).catch(() => undefined);
  }

  /**
   * Whether a claimed payment whose checks failed with `reason` may still land, so the answer must stay retryable:
   * its nonce is used (mined, not yet visible to the receipt lookup), or its deadline passed (the facilitator
   * enforces it, the chain does not) and the chain does not show its nonce unused, pending included.
   */
  private async mayStillLand(d: DecodedEoaPayment, reason: string, deadline: number): Promise<boolean> {
    if (!this.store.isClaimed(d.txHash)) return false;
    if (reason === "nonce_used") return true;
    return reason === "payment_expired" && (await this.within(deadline, () => this.nonceUsed(d))) !== false;
  }

  /** Waits one poll interval, or less if the deadline comes first. */
  private pause(deadline: number) {
    return new Promise((r) => setTimeout(r, Math.max(0, Math.min(this.pollIntervalMs, deadline - this.now()))));
  }

  private async settleOnce(d: DecodedEoaPayment, req: PaymentRequirements): Promise<SettleResponse> {
    // The whole settle, lookups, checks and submission included, fits in one window.
    const deadline = this.now() + this.settleTimeoutMs;
    const sender = d.sender.toLowerCase();
    const outcome = (receipt: TransactionReceipt): SettleResponse => {
      const hash = d.txHash;
      let r: SettleResponse;
      if (receipt.status !== "success") r = this.fail("tx_reverted", "the transfer reverted on chain", d.sender, hash);
      else if (!hasPaymentTransfer(receipt.logs, d.sender, d)) r = this.fail("payment_transfer_missing", TRANSFER_MISSING, d.sender, hash);
      else r = { success: true, payer: d.sender, transaction: hash, network: NETWORK, amount: d.amount.toString() };
      // A success is reported only once it is durably recorded, so one payment is never a success twice (SPEC 2.3).
      // If the write fails, the claim stays and resending the same payload records and reports it once storage works.
      try {
        this.store.set(d.txHash, r);
      } catch (e) {
        this.log({ event: "store_error", hash: d.txHash, error: logMessage(e) });
        if (r.success) return this.fail("settle_unrecorded", "the payment executed but could not be recorded; resend the same payload", d.sender, hash);
      }
      return r;
    };

    // It may already be on chain from an attempt that timed out. It is reported to this caller only if this
    // facilitator claimed it before submitting; otherwise it was settled elsewhere, or its record was lost.
    let receipt = await this.within(deadline, () => this.receipt(d.txHash));
    if (receipt && !this.store.isClaimed(d.txHash)) {
      return this.fail("already_settled", "this transaction is already on chain and was not submitted for this request", d.sender, d.txHash);
    }
    // The answer when no receipt shows up in time. While this facilitator holds the claim, a retry can still find
    // the receipt, so that answer is always settle_timeout.
    const noReceipt = this.fail("settle_timeout", "no receipt within the settle window; resend the same payload", d.sender);
    if (!receipt) {
      if (this.busy.has(sender)) return this.fail("payer_busy", "another payment from this payer is being settled", d.sender);
      this.busy.add(sender);
      try {
        let submit = true;
        try {
          this.checkDeadline(d, req);
          await withDeadline(this.checkChain(d, { rejectSettled: false, rejectBusy: false }), deadline - this.now());
        } catch (e) {
          if (e instanceof SettleDeadlineError) {
            this.log({ event: "settle_checks_timeout", hash: d.txHash });
            return this.fail("settle_timeout", "the checks did not finish within the settle window; nothing was submitted; resend the same payload", d.sender);
          }
          const v = this.invalid(e, "unexpected_settle_error");
          // Submitted here before and it may still land: wait for the receipt instead of failing, and never submit
          // it again (past its deadline, or with its nonce used).
          if (!(await this.mayStillLand(d, v.invalidReason ?? "", deadline))) return this.fail(v.invalidReason ?? "unexpected_settle_error", v.invalidMessage ?? "", d.sender);
          submit = false;
        }
        if (submit) {
          // Whether an earlier settle submitted it and lost the answer: a copy of it may then be in a mempool.
          const claimedBefore = this.store.isClaimed(d.txHash);
          try {
            this.store.claim(d.txHash);
          } catch (e) {
            this.log({ event: "store_error", hash: d.txHash, error: logMessage(e) });
            return this.fail("store_unavailable", "the facilitator cannot record payments right now; nothing was submitted", d.sender);
          }
          try {
            await withDeadline(this.chain.client.sendRawTransaction({ serializedTransaction: d.raw as `0x02${string}` }), deadline - this.now());
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (/already known|known transaction|already in/i.test(message)) {
              // Submitted before: wait for its receipt.
            } else if (refusedOnSubmit(e)) {
              // A refusal is final only when nothing says the payment may still land. A nonce refusal, or any refusal
              // of a resend after an earlier settle submitted it, keeps the claim without trusting a read: behind a
              // load-balanced RPC, the receipt and nonce reads can reach a node that has not seen the payment yet.
              // A payment that never lands is answered payment_expired once its deadline passes (at most 300 s).
              receipt = await this.within(deadline, () => this.receipt(d.txHash));
              const used = receipt || nonceRefusal(message) || claimedBefore ? true : await this.within(deadline, () => this.nonceUsed(d));
              if (used === false) {
                try {
                  this.store.release(d.txHash);
                } catch (e) {
                  // A claim that cannot be released only lingers until CLAIM_TTL_MS.
                  this.log({ event: "store_error", hash: d.txHash, error: logMessage(e) });
                }
                this.log({ event: "payment_error", reason: "tx_rejected", error: logMessage(e) });
                return this.fail("tx_rejected", publicMessage(e), d.sender);
              }
              // It may still land: a nonce refusal, a resend, the nonce used or pending (this transaction, or a rival
              // from the same payer), or the RPC cannot say.
              this.log({ event: "submit_unknown", hash: d.txHash, error: logMessage(e) });
            } else {
              // No answer (a lost connection, a timeout): the node may have accepted it. The claim stays and the
              // receipt decides; a settle_timeout is retried with the same payload and reconciles the same hash.
              this.log({ event: "submit_unknown", hash: d.txHash, error: logMessage(e) });
            }
          }
        }
        while (!receipt && this.now() < deadline) {
          await this.pause(deadline);
          receipt = await this.within(deadline, () => this.receipt(d.txHash));
        }
      } finally {
        this.busy.delete(sender);
      }
    }
    if (!receipt) return noReceipt;
    return outcome(receipt);
  }
}
