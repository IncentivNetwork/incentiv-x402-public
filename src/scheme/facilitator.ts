import { getAddress, hashMessage, isAddressEqual, recoverAddress, decodeFunctionData, type Address, type Hex } from "viem";
import type { Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import { accountAbi, accountFactoryAbi, entryPointAbi, erc20Abi, TRANSFER_GATE_REASONS, transferGateAbi } from "../abi.js";
import { MAINNET, MAX_TIMEOUT_SECONDS, NETWORK, SCHEME, ZERO32, type IncentivConfig } from "../constants.js";
import { checkPaysRequirements, decodePaymentOp, PaymentError, type DecodedPayment } from "../decode.js";
import { MemoryStore, type SettledStore } from "../facilitator/store.js";
import {
  bundlerRpc,
  centAvailable,
  requiredPrefund,
  computeUserOpHash,
  getOpReceipt,
  makeChain,
  opFromWire,
  opToWire,
  paymentNonceKey,
  sendUserOp,
  type Chain,
  type UserOp,
} from "../userop.js";
import type { UserOpPaymentPayload } from "./client.js";

const MAGIC_VALUE = "0x1626ba7e";
const CLOCK_SKEW_SECONDS = 5;

export interface FacilitatorOptions {
  config?: IncentivConfig;
  store?: SettledStore;
  /** How long /settle waits for a receipt before answering settle_timeout. */
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

type Parsed = Checked & { validUntil: number; maxTimeoutSeconds: number };

interface Checked {
  op: UserOp;
  userOpHash: Hex;
  decoded: DecodedPayment;
  payer: Address;
}

/** Facilitator side of `incentiv-userop`: verifies a signed user operation and settles it through the bundler. */
export class IncentivUserOpFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = NETWORK;
  private readonly cfg: IncentivConfig;
  private readonly chain: Chain;
  private readonly store: SettledStore;
  private readonly settleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<SettleResponse>>();

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
      const c = await this.check(payload, requirements, { rejectSettled: true });
      return { isValid: true, payer: c.payer };
    } catch (e) {
      return this.invalid(e);
    }
  }

  private invalid(e: unknown): VerifyResponse {
    if (e instanceof PaymentError) return { isValid: false, invalidReason: e.reason, invalidMessage: e.message };
    return { isValid: false, invalidReason: "unexpected_verify_error", invalidMessage: e instanceof Error ? e.message : String(e) };
  }

  private async check(payload: PaymentPayload, req: PaymentRequirements, opts: { rejectSettled: boolean }): Promise<Checked> {
    const parsed = this.parse(payload, req);
    this.checkDeadline(parsed);
    return this.checkChain(parsed, opts);
  }

  /** The facilitator enforces the deadline; the chain has no validity window. */
  private checkDeadline({ validUntil, maxTimeoutSeconds }: { validUntil: number; maxTimeoutSeconds: number }): void {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (validUntil <= nowSeconds) throw new PaymentError("payment_expired", "validUntil has passed");
    const window = Math.min(maxTimeoutSeconds, MAX_TIMEOUT_SECONDS) + CLOCK_SKEW_SECONDS;
    if (validUntil > nowSeconds + window) throw new PaymentError("invalid_payment_requirements", "validUntil is further away than maxTimeoutSeconds");
  }

  /** Checks that need no chain access: scheme, expiry, hash, calldata and the nonce lane. */
  private parse(payload: PaymentPayload, req: PaymentRequirements): Parsed {
    // 1. Scheme, network and the requirements the client says it accepted.
    if (payload.x402Version !== 2) throw new PaymentError("invalid_x402_version", "x402 version must be 2");
    if (req.scheme !== SCHEME || payload.accepted?.scheme !== SCHEME) throw new PaymentError("invalid_scheme", `scheme must be ${SCHEME}`);
    if (req.network !== NETWORK || payload.accepted?.network !== NETWORK) throw new PaymentError("invalid_network", `network must be ${NETWORK}`);
    for (const k of ["asset", "payTo", "amount"] as const) {
      if (String(payload.accepted[k]).toLowerCase() !== String(req[k]).toLowerCase()) {
        throw new PaymentError("invalid_payment_requirements", `accepted.${k} differs from the requirements`);
      }
    }
    if (typeof req.extra?.entryPoint !== "string" || !isAddressEqual(req.extra.entryPoint as Address, this.cfg.entryPoint)) {
      throw new PaymentError("invalid_payment_requirements", "requirements name an unexpected EntryPoint");
    }
    if (!Number.isInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) {
      throw new PaymentError("invalid_payment_requirements", "maxTimeoutSeconds must be a positive integer");
    }

    // 2. The payload itself.
    const p = payload.payload as Partial<UserOpPaymentPayload>;
    if (typeof p?.paymentId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.paymentId)) throw new PaymentError("invalid_payload", "paymentId must be 32 bytes");
    if (!Number.isInteger(p.validUntil)) throw new PaymentError("invalid_payload", "validUntil must be an integer");
    if (typeof p.userOpHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.userOpHash)) throw new PaymentError("invalid_payload", "userOpHash must be 32 bytes");
    let op: UserOp;
    try {
      op = opFromWire(p.userOperation);
    } catch (e) {
      throw new PaymentError("invalid_payload", e instanceof Error ? e.message : "malformed userOperation");
    }
    const paymentId = p.paymentId as Hex;
    const validUntil = p.validUntil as number;

    // 3. Expiry is checked separately (checkDeadline): a settle retry looks for a receipt first.

    // 4. The hash the signature covers.
    const userOpHash = computeUserOpHash(op, this.cfg.entryPoint, this.cfg.chainId);
    if (userOpHash.toLowerCase() !== p.userOpHash.toLowerCase()) throw new PaymentError("invalid_payload", "userOpHash does not match the operation");

    // 5. The operation pays exactly what the 402 asked for, and nothing else.
    const decoded = decodePaymentOp(op, this.cfg);
    checkPaysRequirements(decoded, req);

    // 6. The nonce lane is the one this payment id and deadline derive.
    if (op.nonce >> 64n !== paymentNonceKey(paymentId, validUntil)) {
      throw new PaymentError("invalid_payload", "nonce lane does not match paymentId and validUntil");
    }
    return { op, userOpHash, decoded, payer: getAddress(op.sender), validUntil, maxTimeoutSeconds: req.maxTimeoutSeconds };
  }

  /** Checks against the chain: replay, signature, funds, TransferGate and simulation. */
  private async checkChain({ op, userOpHash, decoded, payer }: Parsed, opts: { rejectSettled: boolean }): Promise<Checked> {
    if (opts.rejectSettled && this.store.get(userOpHash)) throw new PaymentError("already_settled", "this operation was already settled");
    const current = await this.chain.client.readContract({
      address: this.cfg.entryPoint,
      abi: entryPointAbi,
      functionName: "getNonce",
      args: [op.sender, op.nonce >> 64n],
    });
    if (current !== op.nonce) throw new PaymentError("nonce_used", `account nonce is ${current}, operation uses ${op.nonce}`);

    // 7. Signature: the owner's, checked the way the account will check it.
    await this.checkSignature(op, userOpHash);

    // 8. Funds: payment plus gas fee, in the payment token. Without a paymaster the account's CENT must cover the gas instead.
    if (!op.paymaster) {
      const needed = requiredPrefund(op);
      const have = await centAvailable(this.chain, op.sender);
      if (have < needed) throw new PaymentError("insufficient_funds", `CENT deposit plus balance ${have} is below the ${needed} the operation may need for gas`);
    }
    const balance = await this.chain.client.readContract({ address: decoded.token, abi: erc20Abi, functionName: "balanceOf", args: [op.sender] });
    if (balance < decoded.amount + (decoded.gasFee ?? 0n)) {
      throw new PaymentError("insufficient_funds", `balance ${balance} is below payment ${decoded.amount} plus gas ${decoded.gasFee ?? 0n}`);
    }

    // 9. TransferGate, as the account will run it.
    for (const call of decoded.calls) {
      let reject: number;
      try {
        const r = await this.chain.client.readContract({
          address: this.cfg.transferGate,
          abi: transferGateAbi,
          functionName: "checkApproval",
          args: [call.to, call.value, call.data],
          account: op.sender,
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

    // 10. The bundler can simulate it.
    try {
      await bundlerRpc(this.chain, "eth_estimateUserOperationGas", [opToWire(op), this.cfg.entryPoint]);
    } catch (e) {
      throw new PaymentError("simulation_failed", e instanceof Error ? e.message : String(e));
    }

    return { op, userOpHash, decoded, payer };
  }

  private async checkSignature(op: UserOp, userOpHash: Hex): Promise<void> {
    const code = await this.chain.client.getCode({ address: op.sender });
    if (code && code !== "0x") {
      let magic: Hex | undefined;
      try {
        magic = await this.chain.client.readContract({ address: op.sender, abi: accountAbi, functionName: "isValidSignature", args: [userOpHash, op.signature] });
      } catch {
        /* a revert is an invalid signature */
      }
      if (magic !== MAGIC_VALUE) throw new PaymentError("invalid_signature", "the account does not accept this signature");
      return;
    }
    // Undeployed: the operation must deploy exactly this account, and its owner must have signed.
    if (!op.factory || !op.factoryData || !isAddressEqual(op.factory, this.cfg.accountFactory)) {
      throw new PaymentError("invalid_signature", "the account is not deployed and the operation does not deploy it through the account factory");
    }
    let owner: Address, publicKey: readonly [Hex, Hex], salt: bigint;
    try {
      const d = decodeFunctionData({ abi: accountFactoryAbi, data: op.factoryData });
      if (d.functionName !== "createAccount") throw new Error("not createAccount");
      [owner, publicKey, salt] = d.args as unknown as [Address, readonly [Hex, Hex], bigint];
    } catch {
      throw new PaymentError("invalid_signature", "factoryData is not a createAccount call");
    }
    if (publicKey[0] !== ZERO32 || publicKey[1] !== ZERO32) throw new PaymentError("invalid_signature", "only EOA-owned accounts are accepted");
    const derived = await this.chain.client.readContract({ address: this.cfg.accountFactory, abi: accountFactoryAbi, functionName: "getAddress", args: [owner, publicKey, salt] });
    if (!isAddressEqual(derived, op.sender)) throw new PaymentError("invalid_signature", "factoryData deploys a different account than the sender");
    let signer: Address | undefined;
    try {
      signer = await recoverAddress({ hash: hashMessage({ raw: userOpHash }), signature: op.signature });
    } catch {
      /* falls through */
    }
    if (!signer || !isAddressEqual(signer, owner)) throw new PaymentError("invalid_signature", "the signature is not the account owner's");
  }

  // --- settle ---------------------------------------------------------------

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const hash = (payload.payload as Partial<UserOpPaymentPayload>)?.userOpHash;
    const key = typeof hash === "string" ? hash.toLowerCase() : undefined;
    if (key) {
      // One settlement, one claimant. A payment that is final, or being settled for another request,
      // is never reported as a success again, or one payment could serve many requests.
      if (this.store.get(key)) return this.fail("already_settled", "this operation was already settled");
      if (this.inflight.has(key)) return this.fail("already_settling", "another request is settling this payment");
    }
    const run = this.settleOnce(payload, requirements).finally(() => key && this.inflight.delete(key));
    if (key) this.inflight.set(key, run);
    return run;
  }

  private fail(reason: string, message: string, payer?: Address, transaction = ""): SettleResponse {
    return { success: false, errorReason: reason, errorMessage: message, payer, transaction, network: NETWORK };
  }

  private async settleOnce(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    let c: Parsed;
    try {
      c = this.parse(payload, req);
    } catch (e) {
      const v = this.invalid(e);
      return this.fail(v.invalidReason ?? "unexpected_settle_error", v.invalidMessage ?? "", undefined);
    }
    const remember = (r: SettleResponse) => {
      this.store.set(c.userOpHash, r);
      return r;
    };
    const succeeded = (transaction: string | undefined): SettleResponse => ({
      success: true,
      payer: c.payer,
      transaction: transaction ?? "",
      network: NETWORK,
      amount: c.decoded.amount.toString(),
    });

    // The operation may already be on chain from an earlier attempt that timed out. It is reported to this
    // caller only if this facilitator claimed it before submitting; otherwise it was settled elsewhere, or its
    // record was lost, and reporting it again could serve a second request for one payment.
    let receipt = await getOpReceipt(this.chain, c.userOpHash).catch(() => undefined);
    if (receipt && !this.store.isClaimed(c.userOpHash)) {
      return this.fail("already_settled", "this operation is already on chain and was not submitted for this request", c.payer, receipt.transactionHash ?? "");
    }
    if (!receipt) {
      try {
        this.checkDeadline(c);
        c = { ...c, ...(await this.checkChain(c, { rejectSettled: false })) };
      } catch (e) {
        const v = this.invalid(e);
        return this.fail(v.invalidReason ?? "unexpected_settle_error", v.invalidMessage ?? "", c.payer);
      }
      this.store.claim(c.userOpHash);
      try {
        await sendUserOp(this.chain, c.op);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!/already (known|in)|duplicate|replacement/i.test(message)) {
          this.store.release(c.userOpHash);
          return this.fail("userop_rejected", message, c.payer);
        }
      }
    }
    const deadline = this.now() + this.settleTimeoutMs;
    while (!receipt && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      receipt = await getOpReceipt(this.chain, c.userOpHash).catch(() => undefined);
    }
    if (!receipt) return this.fail("settle_timeout", "no receipt within the settle window; resend the same payload", c.payer);

    if (!receipt.success) {
      return remember(this.fail("userop_reverted", receipt.reason ?? "the operation reverted on chain", c.payer, receipt.transactionHash ?? ""));
    }
    return remember(succeeded(receipt.transactionHash));
  }
}
