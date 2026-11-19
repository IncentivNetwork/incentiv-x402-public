import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { erc20Abi } from "./abi.js";
import { MAX_EOA_GAS } from "./constants.js";
import { PaymentError } from "./decode.js";

const MARKER_PREFIX = "78343032"; // "x402"

/** The access-list address that carries the deadline: "x402", validUntil as a uint64, 8 zero bytes. */
export function deadlineMarker(validUntil: number): Address {
  return `0x${MARKER_PREFIX}${BigInt(validUntil).toString(16).padStart(16, "0")}${"0".repeat(16)}`;
}

function readMarker(address: string): number | undefined {
  const m = new RegExp(`^0x${MARKER_PREFIX}([0-9a-f]{16})0{16}$`, "i").exec(address);
  if (!m) return undefined;
  const value = hexToBigInt(`0x${m[1]}`);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

export interface DecodedEoaPayment {
  raw: Hex;
  txHash: Hex;
  sender: Address;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  validUntil: number;
  token: Address;
  to: Address;
  amount: bigint;
  data: Hex;
}

/** Parse and strictly check a signed EIP-1559 USDC transfer that carries a deadline marker. */
export async function decodeEoaPayment(raw: unknown, chainId: number): Promise<DecodedEoaPayment> {
  if (typeof raw !== "string" || !/^0x02[0-9a-fA-F]+$/.test(raw)) {
    throw new PaymentError("invalid_payload", "signedTransaction must be a raw EIP-1559 (type 2) transaction");
  }
  let tx;
  try {
    tx = parseTransaction(raw as Hex);
  } catch {
    throw new PaymentError("invalid_payload", "signedTransaction does not parse");
  }
  if (tx.type !== "eip1559") throw new PaymentError("invalid_payload", "not an EIP-1559 transaction");
  const t = tx as TransactionSerializableEIP1559 & { r?: Hex; s?: Hex; yParity?: number };
  if (serializeTransaction(t as never).toLowerCase() !== raw.toLowerCase()) {
    throw new PaymentError("invalid_payload", "transaction is not canonically encoded");
  }
  if (t.chainId !== chainId) throw new PaymentError("invalid_payload", `chainId must be ${chainId}`);
  if (!t.to) throw new PaymentError("invalid_payload", "contract creation is not a payment");
  if (t.value && t.value !== 0n) throw new PaymentError("invalid_payload", "the transaction sends native value");
  if (t.nonce === undefined || t.gas === undefined || t.maxFeePerGas === undefined) throw new PaymentError("invalid_payload", "missing nonce or fee fields");
  if (t.gas > MAX_EOA_GAS) throw new PaymentError("invalid_payload", `gas limit ${t.gas} is above ${MAX_EOA_GAS}`);

  const list = t.accessList ?? [];
  if (list.length !== 1 || list[0]!.storageKeys.length !== 0) {
    throw new PaymentError("invalid_payload", "accessList must hold exactly one entry with no storage keys: the deadline marker");
  }
  const validUntil = readMarker(list[0]!.address);
  if (validUntil === undefined) throw new PaymentError("invalid_payload", "accessList entry is not a deadline marker");

  const data = (t.data ?? "0x") as Hex;
  let call;
  try {
    call = decodeFunctionData({ abi: erc20Abi, data });
  } catch {
    throw new PaymentError("invalid_payload", "data is not an ERC-20 call");
  }
  if (call.functionName !== "transfer") throw new PaymentError("invalid_payload", "data is not a transfer");
  const [to, amount] = call.args as readonly [Address, bigint];
  if (encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }).toLowerCase() !== data.toLowerCase()) {
    throw new PaymentError("invalid_payload", "transfer data is not canonical");
  }

  let sender: Address;
  try {
    sender = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
  } catch {
    throw new PaymentError("invalid_signature", "the signature does not recover a sender");
  }
  return {
    raw: raw as Hex,
    txHash: keccak256(raw as Hex),
    sender: getAddress(sender),
    nonce: t.nonce,
    gas: t.gas,
    maxFeePerGas: t.maxFeePerGas,
    validUntil,
    token: getAddress(t.to),
    to: getAddress(to),
    amount,
    data,
  };
}
