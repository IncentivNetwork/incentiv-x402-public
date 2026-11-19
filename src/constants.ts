import type { Address } from "viem";

export const SCHEME = "incentiv-userop";
export const NETWORK = "eip155:24101" as const;
export const CHAIN_ID = 24101;

export interface IncentivConfig {
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  entryPoint: Address;
  accountFactory: Address;
  paymaster: Address;
  transferGate: Address;
  quoter: Address;
  wcent: Address;
  usdc: Address;
}

/** Incentiv mainnet, from the incentiv-mcp preset. */
export const MAINNET: IncentivConfig = {
  chainId: CHAIN_ID,
  rpcUrl: "https://rpc.incentiv.io",
  bundlerUrl: "https://bundler.incentiv.io",
  entryPoint: "0x3eC61c5633BBD7Afa9144C6610930489736a72d4",
  accountFactory: "0xfED842F3C1d054361A840AE863C0b72db5CB2a32",
  paymaster: "0x43000f785EB43BcB4961C5c70276eD00e088972c",
  transferGate: "0x66F51d740d0Ab781bc525B52d0d35D0585086Aa1",
  quoter: "0x1d317fFfBc3Bda5aA06F9f8f506e8C6082dC415A",
  wcent: "0xB0f0A14A50F14dc9e6476d61C00cF0375Dd4EB04",
  usdc: "0x16e43840d8D79896A389a3De85aB0B0210C05685",
};

export const USDC_DECIMALS = 6;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 300;
export const ZERO32 = `0x${"0".repeat(64)}` as const;

export const EOA_SCHEME = "incentiv-eoa-tx";
/** A USDC transfer costs well under this; a higher limit is refused. */
export const MAX_EOA_GAS = 120_000n;
