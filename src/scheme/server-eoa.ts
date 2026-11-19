import type { PaymentRequirements, SupportedKind } from "@x402/core/types";
import { EOA_SCHEME, MAX_TIMEOUT_SECONDS } from "../constants.js";
import { IncentivUserOpScheme } from "./server.js";

/** Server side of `incentiv-eoa-tx`: the same prices and USDC as `incentiv-userop`, with no extra fields. */
export class IncentivEoaTxScheme extends IncentivUserOpScheme {
  override readonly scheme: string = EOA_SCHEME;

  override async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    return { ...requirements, maxTimeoutSeconds: Math.min(requirements.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS) };
  }
}
