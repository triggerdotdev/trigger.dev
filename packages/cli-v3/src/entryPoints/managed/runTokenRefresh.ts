import {
  RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS,
  type RunTokenHeartbeatReport,
  type RunTokenInstallResult,
  type RunTokenRefreshTrigger,
} from "@trigger.dev/core/v3/workers";

export type RunTokenUpdate = { runId: string; attemptNumber: number; token: string };
export type RunTokenInstaller = (update: RunTokenUpdate) => Promise<RunTokenInstallResult>;

type InstallReport = NonNullable<RunTokenHeartbeatReport["installation"]>;

/**
 * Tracks the run token installed in one attempt's task process. It reports the installed expiry on
 * heartbeats so the server can decide when a replacement is due, and installs replacements with an
 * acknowledgement from the task process. Failed installs keep the old expiry, so the next
 * heartbeat asks again.
 */
export class RunTokenRefresher {
  private expiresAt?: number;
  private installing = false;
  private pendingReport?: InstallReport;

  constructor(
    private readonly opts: {
      runId: string;
      attemptNumber: number;
      /** TRIGGER_RUN_TOKEN from the attempt's start response, if one was issued. */
      initialToken: string | undefined;
      install: RunTokenInstaller;
      now?: () => number;
    }
  ) {
    this.expiresAt = opts.initialToken ? claimsOf(opts.initialToken)?.exp : undefined;
  }

  /** Undefined when this attempt has no run token, or while a replacement is being installed. */
  report(trigger: RunTokenRefreshTrigger): RunTokenHeartbeatReport | undefined {
    if (this.expiresAt === undefined || this.installing) return undefined;
    return { expiresAt: this.expiresAt, trigger, installation: this.pendingReport };
  }

  get isDue(): boolean {
    return (
      this.expiresAt !== undefined &&
      this.expiresAt - this.nowSeconds() <= RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS
    );
  }

  /** Call after the heartbeat that carried `sent` succeeded, with any replacement it returned. */
  async handleHeartbeatResponse(
    sent: RunTokenHeartbeatReport | undefined,
    replacement: string | undefined
  ): Promise<RunTokenInstallResult | undefined> {
    if (!sent || this.installing) return undefined;
    if (sent.installation === this.pendingReport) this.pendingReport = undefined;
    if (!replacement) return undefined;

    const claims = claimsOf(replacement);
    let outcome: RunTokenInstallResult;

    if (
      !claims ||
      claims.run_id !== this.opts.runId ||
      claims.attempt !== this.opts.attemptNumber ||
      claims.exp === undefined
    ) {
      outcome = { result: "failure", reason: "invalid_token" };
    } else {
      this.installing = true;
      try {
        outcome = await this.opts.install({
          runId: this.opts.runId,
          attemptNumber: this.opts.attemptNumber,
          token: replacement,
        });
      } finally {
        this.installing = false;
      }

      if (outcome.result === "success") this.expiresAt = claims.exp;
    }

    this.pendingReport = { ...outcome, trigger: sent.trigger };
    return outcome;
  }

  private nowSeconds() {
    return (this.opts.now?.() ?? Date.now()) / 1_000;
  }
}

// Not verification: the token came from the control plane, this only reads timing and identity.
function claimsOf(
  token: string
): { exp?: number; run_id?: unknown; attempt?: unknown } | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object") return undefined;
    return {
      exp: typeof claims.exp === "number" ? claims.exp : undefined,
      run_id: claims.run_id,
      attempt: claims.attempt,
    };
  } catch {
    return undefined;
  }
}
