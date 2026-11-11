import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";

const DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

export function externalOidcTelemetry() {
  return singleton("externalOidcTelemetry", () => {
    const meter = getMeter("external-oidc");
    return {
      tokenRequests: meter.createCounter("external_oidc.token.requests", {
        description: "External OIDC token requests by outcome",
      }),
      tokenDuration: meter.createHistogram("external_oidc.token.duration", {
        description: "External OIDC token request duration by outcome",
        unit: "ms",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
      }),
      metadataDuration: meter.createHistogram("external_oidc.metadata.duration", {
        description: "External OIDC metadata request duration and count",
        unit: "ms",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
      }),
    };
  });
}

export async function withOidcMetadataTelemetry(
  endpoint: "jwks" | "discovery",
  fn: () => Response | Promise<Response>
): Promise<Response> {
  const startedAt = performance.now();
  let status = 500;
  try {
    const response = await fn();
    status = response.status;
    return response;
  } catch (error) {
    if (error instanceof Response) status = error.status;
    throw error;
  } finally {
    externalOidcTelemetry().metadataDuration.record(performance.now() - startedAt, {
      endpoint,
      status_class: `${Math.floor(status / 100)}xx`,
    });
  }
}
