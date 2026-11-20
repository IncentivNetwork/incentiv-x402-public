import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, isAddressEqual, type Address, type Hex } from "viem";
import { accountAbi, erc20Abi } from "./abi.js";
import type { IncentivConfig } from "./constants.js";
import { encodeExecuteBatch, type Call, type UserOp } from "./userop.js";

/**
 * A payment that can be refused with an x402 reason code. `message` is what the client sees; `detail`, when
 * set, is the original error behind it, for the facilitator's log only.
 */
export class PaymentError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** A JSON log line on stderr: the default where no `log` function is given, so errors are never silent. */
export function logToStderr(line: Record<string, unknown>): void {
  console.error(JSON.stringify({ time: new Date().toISOString(), ...line }));
}

/**
 * An error's full text for the facilitator's own log: every line is kept, but each URL is cut to its scheme and
 * host, because RPC and bundler URLs often carry an API key in the path or query.
 */
export function logMessage(e: unknown, max = 4_000): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Each URL (up to whitespace or a double quote, so a URL inside JSON keeps the fields after it) is parsed, and
  // only its host is kept: credentials in user:password@, the path and the query all go. Brackets, apostrophes
  // and backticks are left to the cut, so none of them in a key can end it early (a closing quote after a URL is
  // lost with it). What does not parse is replaced whole.
  return raw
    .replace(/\b(https?|wss?):\/\/[^\s"]+/gi, (url, scheme: string) => {
      try {
        return `${scheme}://${new URL(url).host}/…`;
      } catch {
        return `${scheme}://<url>`;
      }
    })
    .slice(0, max);
}

/**
 * A one-line error message that is safe to send to a client. Library errors carry the RPC URL (which often
 * holds an API key), request bodies and version details on later lines; those stay in the facilitator's logs.
 */
export function publicMessage(e: unknown, max = 300): string {
  const short = e instanceof Error ? (e as { shortMessage?: unknown }).shortMessage : undefined;
  // viem's shortMessage is the whole summary (a revert reason sits on its second line); a plain message keeps its first line.
  const raw = typeof short === "string" ? short.split("\n").map((l) => l.trim()).filter(Boolean).join(" ") : (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
  return raw.replace(/\b(?:https?|wss?):\/\/\S+/gi, "<url>").slice(0, max);
}

export interface DecodedPayment {
  /** The transfer the operation makes to the merchant. */
  token: Address;
  to: Address;
  amount: bigint;
  /** The gas payment to the paymaster, when the operation uses it. */
  gasFee?: bigint;
  calls: Call[];
}

function decodeTransfer(call: Call, what: string): { token: Address; to: Address; amount: bigint } {
  if (call.value !== 0n) throw new PaymentError("invalid_payload", `${what} call sends native value`);
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
  } catch {
    throw new PaymentError("invalid_payload", `${what} call is not an ERC-20 call`);
  }
  if (decoded.functionName !== "transfer") throw new PaymentError("invalid_payload", `${what} call is not a transfer`);
  const [to, amount] = decoded.args as readonly [Address, bigint];
  // A canonical encoding only: a lenient decode must not hide bytes the token could read differently.
  if (encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }).toLowerCase() !== call.data.toLowerCase()) {
    throw new PaymentError("invalid_payload", `${what} call data is not canonical`);
  }
  return { token: getAddress(call.to), to: getAddress(to), amount };
}

/**
 * Decode a payment operation and confirm it contains exactly the expected calls:
 * a gas transfer to the paymaster (when it uses one) and one transfer to the merchant.
 */
export function decodePaymentOp(op: UserOp, cfg: IncentivConfig): DecodedPayment {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: accountAbi, data: op.callData });
  } catch {
    throw new PaymentError("invalid_payload", "callData is not an account call");
  }
  if (decoded.functionName !== "executeBatch") throw new PaymentError("invalid_payload", "callData is not executeBatch");
  const [dest, value, func] = decoded.args as readonly [readonly Address[], readonly bigint[], readonly Hex[]];
  const calls: Call[] = dest.map((to, i) => ({ to, value: value[i]!, data: func[i]! }));
  if (encodeExecuteBatch(calls).toLowerCase() !== op.callData.toLowerCase()) {
    throw new PaymentError("invalid_payload", "callData is not canonical");
  }

  if (op.paymaster) {
    if (!isAddressEqual(op.paymaster, cfg.paymaster)) throw new PaymentError("invalid_payload", "unexpected paymaster");
    if (op.paymasterData && op.paymasterData !== "0x") throw new PaymentError("invalid_payload", "paymasterData must be empty");
    if (calls.length !== 2) throw new PaymentError("invalid_payload", "expected a gas transfer and one payment");
    const gas = decodeTransfer(calls[0]!, "gas");
    if (!isAddressEqual(gas.to, cfg.paymaster)) throw new PaymentError("invalid_payload", "gas transfer does not go to the paymaster");
    const pay = decodeTransfer(calls[1]!, "payment");
    if (!isAddressEqual(gas.token, pay.token)) throw new PaymentError("invalid_payload", "gas is paid in a different token than the payment");
    return { ...pay, gasFee: gas.amount, calls };
  }
  if (calls.length !== 1) throw new PaymentError("invalid_payload", "expected exactly one payment");
  return { ...decodeTransfer(calls[0]!, "payment"), calls };
}

/**
 * The facilitator settles USDC payments of at least one atomic unit only. A 0-amount payment, or one in a
 * token anyone can deploy, would cost the payer nothing but gas.
 */
export function checkUsdcPositive(req: { asset: string; amount: string }, cfg: Pick<IncentivConfig, "usdc">): void {
  if (typeof req.asset !== "string" || !isAddress(req.asset, { strict: false }) || !isAddressEqual(req.asset, cfg.usdc)) {
    throw new PaymentError("asset_mismatch", "only USDC payments are settled");
  }
  if (typeof req.amount !== "string" || !/^\d+$/.test(req.amount) || BigInt(req.amount) <= 0n) {
    throw new PaymentError("invalid_payment_requirements", "amount must be a positive integer in atomic units");
  }
}

/** Confirm a decoded payment is the one the 402 asked for. */
export function checkPaysRequirements(
  decoded: Pick<DecodedPayment, "token" | "to" | "amount">,
  req: { asset: string; payTo: string; amount: string },
): void {
  if (!isAddressEqual(decoded.token, req.asset as Address)) {
    throw new PaymentError("asset_mismatch", `pays ${decoded.token}, the 402 asked for ${req.asset}`);
  }
  if (typeof req.payTo !== "string" || !isAddress(req.payTo, { strict: false }) || !isAddressEqual(decoded.to, req.payTo as Address)) {
    throw new PaymentError("payto_mismatch", `pays ${decoded.to}, the 402 asked for ${req.payTo}`);
  }
  if (decoded.amount !== BigInt(req.amount)) {
    throw new PaymentError("amount_mismatch", `pays ${decoded.amount}, the 402 asked for ${req.amount}`);
  }
}
