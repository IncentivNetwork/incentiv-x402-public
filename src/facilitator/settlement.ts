import { decodeEventLog, encodeAbiParameters, encodeEventTopics, isAddressEqual, type Address, type Hex, type Log } from "viem";
import { entryPointAbi, erc20Abi } from "../abi.js";

type ReceiptLog = Pick<Log, "address" | "data" | "topics">;
type Transfer = { token: Address; to: Address; amount: bigint };

export const TRANSFER_MISSING = "the receipt has no matching USDC transfer";

export function hasPaymentTransfer(logs: readonly ReceiptLog[], payer: Address, { token, to, amount }: Transfer): boolean {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: payer, to } });
  const value = encodeAbiParameters([{ type: "uint256" }], [amount]);
  return logs.some((log) =>
    isAddressEqual(log.address, token) && log.data.toLowerCase() === value &&
    log.topics.length === topics.length && log.topics.every((topic, i) => topic.toLowerCase() === topics[i]),
  );
}

const [beforeExecutionTopic] = encodeEventTopics({ abi: entryPointAbi, eventName: "BeforeExecution" });
const [userOperationEventTopic] = encodeEventTopics({ abi: entryPointAbi, eventName: "UserOperationEvent" });

export function userOperationOutcome(
  logs: readonly ReceiptLog[], entryPoint: Address, hash: Hex, payer: Address, nonce: bigint, payment: Transfer,
): "success" | "reverted" | "missing" | undefined {
  let start = -1;
  for (const [index, log] of logs.entries()) {
    if (!isAddressEqual(log.address, entryPoint)) continue;
    const topic = log.topics[0]?.toLowerCase();
    if (topic === beforeExecutionTopic) start = index + 1;
    if (topic !== userOperationEventTopic || start < 0) continue;
    // Each EntryPoint event closes its operation's execution logs, even when the operation reverted.
    const from = start;
    start = index + 1;
    if (log.topics[1]?.toLowerCase() !== hash.toLowerCase()) continue;
    try {
      const { args } = decodeEventLog({ abi: entryPointAbi, eventName: "UserOperationEvent", data: log.data, topics: log.topics });
      if (!isAddressEqual(args.sender, payer) || args.nonce !== nonce) return undefined;
      if (!args.success) return "reverted";
      return hasPaymentTransfer(logs.slice(from, index), payer, payment) ? "success" : "missing";
    } catch {
      return undefined;
    }
  }
  return undefined;
}
