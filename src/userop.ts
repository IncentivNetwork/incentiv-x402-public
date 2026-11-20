import {
  BaseError,
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  HttpRequestError,
  keccak256,
  numberToHex,
  pad,
  RpcRequestError,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountAbi, accountFactoryAbi, entryPointAbi, erc20Abi, paymasterAbi, quoterAbi } from "./abi.js";
import { MAINNET, ZERO32, type IncentivConfig } from "./constants.js";

// The public RPC rejects clients without a browser-like user agent.
const USER_AGENT = "Mozilla/5.0 (compatible; incentiv-x402)";

export interface Chain {
  config: IncentivConfig;
  client: PublicClient;
}

/** viem sends `eth_sendRawTransaction` once (`retryCount: 0`); its reads are retried as configured here. */
export function makeChain(config: IncentivConfig = MAINNET): Chain {
  const client = createPublicClient({
    transport: http(config.rpcUrl, { timeout: 20_000, fetchOptions: { headers: { "User-Agent": USER_AGENT } } }),
  });
  return { config, client };
}

/**
 * A refusal about the nonce: the transaction, or another one from the same sender, may already be on chain or in
 * a node's mempool. Such a refusal never proves the payment will not land.
 */
export function nonceRefusal(message: string): boolean {
  return /nonce too low|nonce has already been used|old ?nonce|nonce.*(too small|already)|replacement transaction underpriced|already imported/i.test(message);
}

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** ERC-4337 v0.7 user operation in the unpacked bundler wire format. */
export interface UserOp {
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;
}

export function encodeExecuteBatch(calls: Call[]): Hex {
  return encodeFunctionData({
    abi: accountAbi,
    functionName: "executeBatch",
    args: [calls.map((c) => c.to), calls.map((c) => c.value), calls.map((c) => c.data)],
  });
}

function packUint128Pair(high: bigint, low: bigint): Hex {
  return concatHex([pad(numberToHex(high), { size: 16 }), pad(numberToHex(low), { size: 16 })]);
}

function packInitCode(op: UserOp): Hex {
  return op.factory ? concatHex([op.factory, op.factoryData ?? "0x"]) : "0x";
}

function packPaymasterAndData(op: UserOp): Hex {
  if (!op.paymaster) return "0x";
  return concatHex([
    op.paymaster,
    pad(numberToHex(op.paymasterVerificationGasLimit ?? 0n), { size: 16 }),
    pad(numberToHex(op.paymasterPostOpGasLimit ?? 0n), { size: 16 }),
    op.paymasterData ?? "0x",
  ]);
}

/** EntryPoint v0.7 getUserOpHash, computed locally. */
export function computeUserOpHash(op: UserOp, entryPoint: Address, chainId: number): Hex {
  const packedHash = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        op.sender,
        op.nonce,
        keccak256(packInitCode(op)),
        keccak256(op.callData),
        packUint128Pair(op.verificationGasLimit, op.callGasLimit),
        op.preVerificationGas,
        packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas),
        keccak256(packPaymasterAndData(op)),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [packedHash, entryPoint, BigInt(chainId)]),
  );
}

export type WireOp = Record<string, string>;

export function opToWire(op: UserOp): WireOp {
  const wire: WireOp = {
    sender: op.sender,
    nonce: toHex(op.nonce),
    callData: op.callData,
    callGasLimit: toHex(op.callGasLimit),
    verificationGasLimit: toHex(op.verificationGasLimit),
    preVerificationGas: toHex(op.preVerificationGas),
    maxFeePerGas: toHex(op.maxFeePerGas),
    maxPriorityFeePerGas: toHex(op.maxPriorityFeePerGas),
    signature: op.signature,
  };
  if (op.factory) {
    wire.factory = op.factory;
    wire.factoryData = op.factoryData ?? "0x";
  }
  if (op.paymaster) {
    wire.paymaster = op.paymaster;
    wire.paymasterVerificationGasLimit = toHex(op.paymasterVerificationGasLimit ?? 0n);
    wire.paymasterPostOpGasLimit = toHex(op.paymasterPostOpGasLimit ?? 0n);
    wire.paymasterData = op.paymasterData ?? "0x";
  }
  return wire;
}

/** Parse a wire-format operation, rejecting anything malformed. */
export function opFromWire(j: unknown): UserOp {
  if (j === null || typeof j !== "object") throw new Error("userOperation must be an object");
  const w = j as Record<string, unknown>;
  const str = (k: string, required = true): string | undefined => {
    const v = w[k];
    if (v === undefined || v === null) {
      if (required) throw new Error(`userOperation is missing "${k}"`);
      return undefined;
    }
    if (typeof v !== "string") throw new Error(`userOperation.${k} must be a hex string`);
    return v;
  };
  const hex = (k: string): Hex => {
    const v = str(k)!;
    if (!/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Error(`userOperation.${k} is not even-length hex`);
    return v as Hex;
  };
  const addr = (k: string): Address => {
    const v = str(k)!;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`userOperation.${k} is not an address`);
    return v as Address;
  };
  // Gas limits and fees are packed into 16 bytes each in the EntryPoint's hash; the nonce and preVerificationGas into 32.
  const big = (k: string, bits = 128): bigint => {
    const v = str(k)!;
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error(`userOperation.${k} must be a 0x quantity`);
    const n = BigInt(v);
    if (n >= 1n << BigInt(bits)) throw new Error(`userOperation.${k} does not fit in ${bits} bits`);
    return n;
  };
  const op: UserOp = {
    sender: addr("sender"),
    nonce: big("nonce", 256),
    callData: hex("callData"),
    callGasLimit: big("callGasLimit"),
    verificationGasLimit: big("verificationGasLimit"),
    preVerificationGas: big("preVerificationGas", 256),
    maxFeePerGas: big("maxFeePerGas"),
    maxPriorityFeePerGas: big("maxPriorityFeePerGas"),
    signature: hex("signature"),
  };
  if (str("factory", false)) {
    op.factory = addr("factory");
    op.factoryData = hex("factoryData");
  }
  if (str("paymaster", false)) {
    op.paymaster = addr("paymaster");
    op.paymasterVerificationGasLimit = big("paymasterVerificationGasLimit");
    op.paymasterPostOpGasLimit = big("paymasterPostOpGasLimit");
    op.paymasterData = hex("paymasterData");
  }
  return op;
}

// --- Bundler ---------------------------------------------------------------

/** A JSON-RPC error the bundler answered with: it received the request and refused it. */
export class BundlerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The bundler answered with an HTTP error status: a 408 or any 5xx (a proxy can answer one after the bundler
 * accepted the request, whatever its body says), or another 4xx without a JSON-RPC error.
 */
export class BundlerHttpError extends Error {
  constructor(
    readonly status: number,
    detail?: string,
  ) {
    super(`Bundler HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * RPC answers about the node rather than the payment (forbidden, timeout, too large, rate limited, unknown,
 * limit exceeded, internal error), the ones viem treats as transient. The node did not judge the payment, so they
 * are not refusals: the claim is kept and a retry decides.
 */
const RPC_TRANSIENT_STATUSES = new Set([403, 408, 413, 429]);
const RPC_TRANSIENT_CODES = new Set([-1, -32005, -32603, 429]);

/**
 * Whether a submission was definitely refused.
 *
 * - The bundler client sends once: a JSON-RPC error other than an internal error (`-32603`), or an HTTP 4xx status
 *   other than 408, is a refusal.
 * - From the RPC, a JSON-RPC error or a 4xx status counts unless it is transient (see RPC_TRANSIENT_*).
 *
 * A lost connection, a timeout and a 5xx status say nothing about whether the payment was accepted, so it may
 * still land. Even a refusal of this request is not always a refusal of the payment: a settle retried after
 * settle_timeout sends it again, and that resend can be refused ("nonce too low") because the first copy landed or
 * is pending. Callers decide what a refusal means for the claim.
 */
export function refusedOnSubmit(e: unknown): boolean {
  const answered = (x: unknown) =>
    (x instanceof BundlerRpcError && x.code !== -32603) ||
    (x instanceof BundlerHttpError && x.status >= 400 && x.status < 500 && x.status !== 408) ||
    (x instanceof RpcRequestError && !RPC_TRANSIENT_CODES.has(x.code)) ||
    (x instanceof HttpRequestError && x.status !== undefined && x.status >= 400 && x.status < 500 && !RPC_TRANSIENT_STATUSES.has(x.status));
  return answered(e) || (e instanceof BaseError && e.walk(answered) !== null);
}

/** Thrown by `withDeadline` when a step of a settle did not finish before the settle deadline. */
export class SettleDeadlineError extends Error {
  constructor() {
    super("no answer before the settle deadline");
  }
}

/**
 * Waits for `p` until `ms` have passed, then gives up with `SettleDeadlineError`. The work itself is not
 * cancelled, so its later answer, or error, is ignored.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new SettleDeadlineError()), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function bundlerRpc(chain: Chain, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(chain.config.bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  // A JSON-RPC error is read with a 2xx or 4xx status: some bundlers send their refusals with a 4xx status. A 408 or
  // 5xx status says nothing certain about the request, so it stays an HTTP error, with the body's message as detail.
  const text = await res.text();
  let body: { result?: unknown; error?: { code: number; message: string; data?: unknown } } | undefined;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = undefined;
  }
  // Any error member is an error, even a malformed one; a code that is not a number is kept as NaN.
  if (body?.error !== undefined && body?.error !== null) {
    const { code, message, data } = body.error as { code?: unknown; message?: unknown; data?: unknown };
    const extra = data ? ` ${JSON.stringify(data)}` : "";
    const text = `Bundler error ${String(code)}: ${String(message)}${extra}`;
    if (res.status >= 500 || res.status === 408) throw new BundlerHttpError(res.status, text);
    throw new BundlerRpcError(typeof code === "number" ? code : NaN, text);
  }
  if (!res.ok) throw new BundlerHttpError(res.status);
  if (typeof body !== "object" || body === null) throw new Error("Bundler answered with invalid JSON");
  return body.result;
}

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" || typeof v === "string") return BigInt(v);
  throw new Error(`Cannot parse gas value: ${String(v)}`);
}

export async function sendUserOp(chain: Chain, op: UserOp): Promise<Hex> {
  return (await bundlerRpc(chain, "eth_sendUserOperation", [opToWire(op), chain.config.entryPoint])) as Hex;
}

export interface OpReceipt {
  userOpHash: Hex;
  success: boolean;
  transactionHash?: Hex;
  blockNumber?: string;
  reason?: string;
}

export async function getOpReceipt(chain: Chain, userOpHash: Hex): Promise<OpReceipt | undefined> {
  const r = (await bundlerRpc(chain, "eth_getUserOperationReceipt", [userOpHash])) as Record<string, unknown> | null;
  if (!r) return undefined;
  const receipt = (r.receipt ?? {}) as Record<string, unknown>;
  return {
    userOpHash,
    success: r.success === true || r.success === "0x1" || r.success === "true",
    transactionHash: (receipt.transactionHash ?? r.transactionHash) as Hex | undefined,
    blockNumber: receipt.blockNumber !== undefined ? String(receipt.blockNumber) : undefined,
    reason: typeof r.reason === "string" ? r.reason : undefined,
  };
}

// --- Fees and paymaster ----------------------------------------------------

/** `headroomPercent` is how far above the current base fee the fee cap sits (200 = twice the base fee). */
async function getFees(chain: Chain, headroomPercent = 200n) {
  const block = await chain.client.getBlock();
  const base = block.baseFeePerGas ?? 12_600_000_000_000n;
  const tip = 1_000_000_000n;
  return { maxFeePerGas: (base * headroomPercent) / 100n + tip, maxPriorityFeePerGas: tip };
}

interface PaymasterConfig {
  gasEstimateCoefficient: bigint;
  usdcToken: Address;
  usdcPoolFee: number;
  minPaymentUsdc: bigint;
  minTransactionGas: bigint;
  maxVerificationGas: bigint;
}

async function getPaymasterConfig(chain: Chain): Promise<PaymasterConfig> {
  const read = <T,>(functionName: string) =>
    chain.client.readContract({ address: chain.config.paymaster, abi: paymasterAbi, functionName: functionName as never }) as Promise<T>;
  const [gasEstimateCoefficient, usdcToken, usdcPoolFee, minPaymentUsdc, minTransactionGas, maxVerificationGas] = await Promise.all([
    read<bigint>("gasEstimateCoefficient"),
    read<Address>("usdcToken"),
    read<number>("usdcPoolFee"),
    read<bigint>("minPaymentUsdc"),
    read<bigint>("minTransactionGas"),
    read<bigint>("maxVerificationGas"),
  ]);
  return { gasEstimateCoefficient, usdcToken, usdcPoolFee: Number(usdcPoolFee), minPaymentUsdc, minTransactionGas, maxVerificationGas };
}

function requiredCentFor(
  cfg: PaymasterConfig,
  limits: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint },
  maxFeePerGas: bigint,
): bigint {
  let ver = limits.verificationGasLimit;
  if (cfg.maxVerificationGas !== 0n && ver > cfg.maxVerificationGas) ver = cfg.maxVerificationGas;
  let totalGas = limits.callGasLimit + ver + limits.preVerificationGas;
  if (totalGas < cfg.minTransactionGas) totalGas = cfg.minTransactionGas;
  return (totalGas * maxFeePerGas * cfg.gasEstimateCoefficient) / 10_000n;
}

/** Token amount (USDC) whose WCENT quote satisfies the paymaster's gas check and floor. */
async function usdcGasAmount(chain: Chain, cfg: PaymasterConfig, requiredCent: bigint): Promise<bigint> {
  const quoteIn = async (wcentOut: bigint) =>
    (
      (await chain.client.readContract({
        address: chain.config.quoter,
        abi: quoterAbi,
        functionName: "quoteExactOutputSingle",
        args: [{ tokenIn: cfg.usdcToken, tokenOut: chain.config.wcent, amount: wcentOut, fee: cfg.usdcPoolFee, sqrtPriceLimitX96: 0n }],
      })) as readonly [bigint, ...unknown[]]
    )[0];
  const quoteOut = async (amountIn: bigint) =>
    (
      (await chain.client.readContract({
        address: chain.config.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: cfg.usdcToken, tokenOut: chain.config.wcent, amountIn, fee: cfg.usdcPoolFee, sqrtPriceLimitX96: 0n }],
      })) as readonly [bigint, ...unknown[]]
    )[0];
  // The paymaster accepts at least minPaymentUsdc, so start from the floor and check that amount.
  let amount = requiredCent === 0n ? 0n : (await quoteIn(requiredCent) * 102n) / 100n;
  if (amount < cfg.minPaymentUsdc) amount = cfg.minPaymentUsdc;
  for (let attempt = 0; requiredCent > 0n; attempt++) {
    if ((await quoteOut(amount)) >= requiredCent) break;
    if (attempt === 5) {
      throw new Error("The USDC/WCENT pool cannot quote a gas fee the paymaster would accept; pay gas in CENT instead (gas: \"native\")");
    }
    const step = amount / 20n; // +5%, and at least 1 so a tiny fee still grows
    amount += step > 0n ? step : 1n;
  }
  return amount;
}

// --- Payment user operation ------------------------------------------------

/** The nonce lane for one payment: a 192-bit key derived from the payment id and deadline. */
export function paymentNonceKey(paymentId: Hex, validUntil: number): bigint {
  const digest = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [paymentId, BigInt(validUntil)]));
  return BigInt(digest) >> 64n; // top 192 bits
}

export function transferCall(token: Address, to: Address, amount: bigint): Call {
  return { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
}

export interface PrepareOptions {
  /** The smart account that pays. */
  account: Address;
  /** Owner EOA; needed only while the account is not deployed. */
  owner: Address;
  salt?: bigint;
  /** The payment: token, recipient, amount. */
  asset: Address;
  payTo: Address;
  amount: bigint;
  paymentId: Hex;
  validUntil: number;
  /** "token" pays gas in USDC through the paymaster (default); "native" pays it in CENT from the account. */
  gas?: "token" | "native";
}

export interface PreparedPayment {
  op: UserOp;
  userOpHash: Hex;
  gasFee: bigint;
  /** The calls the operation executes, in order. */
  calls: Call[];
}

/** Build and estimate an unsigned payment operation: gas in the payment token, one transfer to `payTo`. */
export async function preparePayment(chain: Chain, o: PrepareOptions): Promise<PreparedPayment> {
  if (o.asset.toLowerCase() !== chain.config.usdc.toLowerCase()) {
    throw new Error("Only USDC can pay gas through the paymaster in this version, so only USDC payments are supported.");
  }
  const code = await chain.client.getCode({ address: o.account });
  const deployed = !!code && code !== "0x";
  let init: { factory?: Address; factoryData?: Hex } = {};
  if (!deployed) {
    const derived = await chain.client.readContract({
      address: chain.config.accountFactory,
      abi: accountFactoryAbi,
      functionName: "getAddress",
      args: [o.owner, [ZERO32, ZERO32], o.salt ?? 0n],
    });
    if (derived.toLowerCase() !== o.account.toLowerCase()) {
      throw new Error(`Owner ${o.owner} controls ${derived}, not ${o.account}.`);
    }
    init = {
      factory: chain.config.accountFactory,
      factoryData: encodeFunctionData({ abi: accountFactoryAbi, functionName: "createAccount", args: [o.owner, [ZERO32, ZERO32], o.salt ?? 0n] }),
    };
  }

  const native = o.gas === "native";
  const key = paymentNonceKey(o.paymentId, o.validUntil);
  const [nonce, fees, cfg] = await Promise.all([
    chain.client.readContract({ address: chain.config.entryPoint, abi: entryPointAbi, functionName: "getNonce", args: [o.account, key] }),
    getFees(chain, native ? 130n : 200n),
    native ? undefined : getPaymasterConfig(chain),
  ]);

  const payment = transferCall(o.asset, o.payTo, o.amount);
  const callsWithFee = (fee: bigint): Call[] => (native ? [payment] : [transferCall(o.asset, chain.config.paymaster, fee), payment]);

  let gasFee = 0n;
  if (!native) {
    const seedCent = requiredCentFor(cfg!, { callGasLimit: 600_000n, verificationGasLimit: 100_000n, preVerificationGas: 100_000n }, fees.maxFeePerGas);
    gasFee = await usdcGasAmount(chain, cfg!, seedCent);
  }

  const op: UserOp = {
    sender: o.account,
    nonce,
    ...init,
    callData: encodeExecuteBatch(callsWithFee(gasFee)),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    ...(native
      ? {}
      : { paymaster: chain.config.paymaster, paymasterVerificationGasLimit: 500_000n, paymasterPostOpGasLimit: 50_000n, paymasterData: "0x" as Hex }),
    signature: "0x",
  };

  // Estimation needs a well-formed signature; this throwaway key never leaves the function.
  const ephemeral = privateKeyToAccount(generatePrivateKey());
  for (let i = 0; i < (native ? 1 : 2); i++) {
    const est: UserOp = {
      sender: op.sender,
      nonce: op.nonce,
      factory: op.factory,
      factoryData: op.factoryData,
      callData: op.callData,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: op.maxFeePerGas,
      maxPriorityFeePerGas: op.maxPriorityFeePerGas,
      signature: "0x",
    };
    est.signature = await ephemeral.signMessage({ message: { raw: computeUserOpHash(est, chain.config.entryPoint, chain.config.chainId) } });
    const r = (await bundlerRpc(chain, "eth_estimateUserOperationGas", [opToWire(est), chain.config.entryPoint])) as Record<string, unknown>;
    const [callPct, verPct, prePct] = [120n, 110n, 105n];
    op.callGasLimit = (asBigInt(r.callGasLimit) * callPct) / 100n;
    op.verificationGasLimit = (asBigInt(r.verificationGasLimit ?? r.verificationGas) * verPct) / 100n;
    op.preVerificationGas = (asBigInt(r.preVerificationGas) * prePct) / 100n;
    if (!native) {
      op.paymasterVerificationGasLimit = 300_000n;
      if (cfg!.maxVerificationGas !== 0n && op.verificationGasLimit > cfg!.maxVerificationGas) {
        throw new Error(`The operation needs ${op.verificationGasLimit} verification gas, above the paymaster cap of ${cfg!.maxVerificationGas}.`);
      }
      gasFee = await usdcGasAmount(chain, cfg!, requiredCentFor(cfg!, op, op.maxFeePerGas));
      op.callData = encodeExecuteBatch(callsWithFee(gasFee));
    }
  }
  if (native) {
    // The EntryPoint takes the worst-case gas cost up front, from the account's deposit and balance.
    const needed = requiredPrefund(op);
    const have = await centAvailable(chain, o.account);
    if (have < needed) throw new Error(`The account's CENT (deposit plus balance, ${have}) is below the ${needed} the operation may need for gas.`);
  }

  op.signature = "0x";
  return { op, userOpHash: computeUserOpHash(op, chain.config.entryPoint, chain.config.chainId), gasFee, calls: callsWithFee(gasFee) };
}

/** The most gas the EntryPoint may charge for an operation: all gas limits at the fee cap. */
export function requiredPrefund(op: UserOp): bigint {
  return (op.callGasLimit + op.verificationGasLimit + op.preVerificationGas + (op.paymasterVerificationGasLimit ?? 0n) + (op.paymasterPostOpGasLimit ?? 0n)) * op.maxFeePerGas;
}

/** CENT an account can spend on gas without a paymaster: its EntryPoint deposit plus its balance. */
export async function centAvailable(chain: Chain, account: Address): Promise<bigint> {
  const [deposit, balance] = await Promise.all([
    chain.client.readContract({ address: chain.config.entryPoint, abi: entryPointAbi, functionName: "balanceOf", args: [account] }),
    chain.client.getBalance({ address: account }),
  ]);
  return deposit + balance;
}

/** Sign the operation hash the way the account verifies it: EIP-191 over the raw hash. */
export async function signUserOp(
  op: UserOp,
  userOpHash: Hex,
  signer: { signMessage(args: { message: { raw: Hex } }): Promise<Hex> },
): Promise<UserOp> {
  return { ...op, signature: await signer.signMessage({ message: { raw: userOpHash } }) };
}
