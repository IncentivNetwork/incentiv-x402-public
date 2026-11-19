import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  numberToHex,
  pad,
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

export function makeChain(config: IncentivConfig = MAINNET): Chain {
  const client = createPublicClient({
    transport: http(config.rpcUrl, { timeout: 20_000, fetchOptions: { headers: { "User-Agent": USER_AGENT } } }),
  });
  return { config, client };
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

export async function bundlerRpc(chain: Chain, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(chain.config.bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Bundler HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  if (body.error) {
    const data = body.error.data ? ` ${JSON.stringify(body.error.data)}` : "";
    throw new Error(`Bundler error ${body.error.code}: ${body.error.message}${data}`);
  }
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
  let amount = requiredCent === 0n ? 0n : (await quoteIn(requiredCent) * 102n) / 100n;
  for (let attempt = 0; requiredCent > 0n; attempt++) {
    if ((await quoteOut(amount)) >= requiredCent) break;
    if (attempt === 5) {
      throw new Error("The USDC/WCENT pool cannot quote a gas fee the paymaster would accept; pay gas in CENT instead (gas: \"native\")");
    }
    amount = (amount * 105n) / 100n;
  }
  return amount < cfg.minPaymentUsdc ? cfg.minPaymentUsdc : amount;
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
