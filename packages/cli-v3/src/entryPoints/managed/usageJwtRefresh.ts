import { fromFriendlyId } from "@trigger.dev/core/v3";
import {
  USAGE_JWT_REFRESH_BEFORE_EXPIRY_SECONDS,
  isUsageReportingEnabled,
  type ProdUsageManagerOptions,
} from "@trigger.dev/core/v3/workers";

type UsageJwtUpdate = { runId: string; attemptNumber: number; token: string };

export class UsageJwtRefresher {
  private expiresAt: number | undefined;
  /** Set when the initial credential is not renewable here; the run keeps the legacy billing path. */
  readonly fallbackReason?: string;

  constructor(
    private readonly opts: {
      runId: string;
      attemptNumber: number;
      usageOptions: ProdUsageManagerOptions;
      install: (update: UsageJwtUpdate) => Promise<boolean>;
      now?: () => number;
    }
  ) {
    if (!isUsageReportingEnabled(opts.usageOptions)) return;

    const claims = claimsOf(opts.usageOptions.jwt!);
    if (
      !claims ||
      claims.usage_auth !== "control-plane-v1" ||
      claims.run_id !== fromFriendlyId(opts.runId) ||
      claims.usage_attempt !== String(opts.attemptNumber)
    ) {
      this.fallbackReason =
        "initial billing credential is not renewable by the control plane for this run and attempt; using legacy billing renewal";
      return;
    }

    this.expiresAt = claims.exp;
  }

  get isDue() {
    return (
      this.expiresAt !== undefined &&
      this.expiresAt - (this.opts.now?.() ?? Date.now()) / 1_000 <=
        USAGE_JWT_REFRESH_BEFORE_EXPIRY_SECONDS
    );
  }

  report() {
    return this.isDue
      ? { expiresAt: this.expiresAt!, attemptNumber: this.opts.attemptNumber }
      : undefined;
  }

  async installReplacement(token: string): Promise<boolean> {
    if (this.expiresAt === undefined) return false;

    const claims = claimsOf(token);
    if (
      !claims ||
      claims.run_id !== fromFriendlyId(this.opts.runId) ||
      claims.usage_attempt !== String(this.opts.attemptNumber) ||
      claims.usage_auth !== "control-plane-v1" ||
      claims.exp - (this.opts.now?.() ?? Date.now()) / 1_000 <=
        USAGE_JWT_REFRESH_BEFORE_EXPIRY_SECONDS
    ) {
      return false;
    }

    try {
      const installed = await this.opts.install({
        runId: this.opts.runId,
        attemptNumber: this.opts.attemptNumber,
        token,
      });
      if (installed) this.expiresAt = claims.exp;
      return installed;
    } catch {
      return false;
    }
  }
}

// Timing/identity checks only. The replacement is received over the control-plane connection.
function claimsOf(
  token: string
): { exp: number; run_id?: unknown; usage_attempt?: unknown; usage_auth?: unknown } | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    return typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? claims : undefined;
  } catch {
    return undefined;
  }
}
