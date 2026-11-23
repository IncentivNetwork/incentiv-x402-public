import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const entryPointAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function incrementNonce(uint192 key)",
  "function balanceOf(address account) view returns (uint256)",
  "event BeforeExecution()",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

export const accountFactoryAbi = parseAbi([
  "function getAddress(address owner, bytes32[2] publicKey, uint256 salt) view returns (address)",
  "function createAccount(address owner, bytes32[2] publicKey, uint256 salt) returns (address)",
]);

export const accountAbi = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

// enum RejectionReason { APPROVED, PENDING, GLOBAL_BLACKLIST, INCOMING_BLACKLIST,
//                        INCOMING_WHITELIST, OUTGOING_BLACKLIST, OUTGOING_WHITELIST }
export const transferGateAbi = parseAbi([
  "struct ApprovalResult { uint8 reject; address tokenAddress; uint256 tokenAmount; address tokenFrom; address tokenRecipient; }",
  "function checkApproval(address target, uint256 value, bytes data) view returns (ApprovalResult result)",
]);

export const TRANSFER_GATE_REASONS = [
  "APPROVED",
  "PENDING",
  "GLOBAL_BLACKLIST",
  "INCOMING_BLACKLIST",
  "INCOMING_WHITELIST",
  "OUTGOING_BLACKLIST",
  "OUTGOING_WHITELIST",
] as const;

export const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "struct QuoteExactOutputSingleParams { address tokenIn; address tokenOut; uint256 amount; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle(QuoteExactOutputSingleParams params) view returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const paymasterAbi = parseAbi([
  "function gasEstimateCoefficient() view returns (uint256)",
  "function usdcToken() view returns (address)",
  "function usdcPoolFee() view returns (uint24)",
  "function minPaymentUsdc() view returns (uint256)",
  "function minTransactionGas() view returns (uint256)",
  "function maxVerificationGas() view returns (uint256)",
]);
