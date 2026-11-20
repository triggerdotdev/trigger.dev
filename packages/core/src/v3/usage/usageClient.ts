import { apiClientManager } from "../apiClientManager-api.js";

export type UsageEvent = {
  durationMs: number;
};

export type UsageReportResult = "accepted" | "rejected" | "unknown";

const USAGE_REQUEST_TIMEOUT_MS = 10_000;

const USAGE_REPORT_ID_HEADER = "x-trigger-usage-report-id";

export class UsageClient {
  constructor(
    private readonly url: string,
    private jwt: string
  ) {}

  setJwt(jwt: string): void {
    this.jwt = jwt;
  }

  async sendUsageEvent(event: UsageEvent, reportId?: string): Promise<UsageReportResult> {
    const sentJwt = this.jwt;
    const apiKey = apiClientManager.accessToken;
    try {
      const response = await fetch(this.url, {
        method: "POST",
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "x-trigger-jwt": sentJwt,
          accept: "application/json",
          ...(reportId ? { [USAGE_REPORT_ID_HEADER]: reportId } : {}),
          // A credential the control plane cannot renew still recovers through API-key auth.
          ...(apiKey && !isControlPlaneJwt(sentJwt) ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      });

      if (response.ok) {
        const renewedJwt = response.headers.get("x-trigger-jwt");
        // An in-flight report must not overwrite a control-plane refresh.
        if (renewedJwt && this.jwt === sentJwt) this.jwt = renewedJwt;
        return "accepted";
      }

      // Only 401 is guaranteed to precede accounting. Other failures may follow a partial write.
      const result = response.status === 401 ? "rejected" : "unknown";
      console.error("Usage report failed", {
        status: response.status,
        durationMs: event.durationMs,
        accounting: result === "rejected" ? "retained_for_retry" : "unknown",
      });
      return result;
    } catch {
      console.error("Usage report response unavailable", {
        durationMs: event.durationMs,
        accounting: "unknown",
      });
      return "unknown";
    }
  }
}

function isControlPlaneJwt(jwt: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload?.usage_auth === "control-plane-v1";
  } catch {
    return false;
  }
}
