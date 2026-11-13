import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";

const DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

export function environmentEncryptionTelemetry() {
  return singleton("environmentEncryptionTelemetry", () => {
    const meter = getMeter("environment-encryption");
    return {
      keyOperationDuration: meter.createHistogram("environment_encryption.key_operation.duration", {
        description: "Environment-key wrap/unwrap duration and outcomes, including KMS queue wait",
        unit: "ms",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
      }),
      cacheLookups: meter.createCounter("environment_encryption.key_cache.lookups", {
        description: "Distinct environment-key cache hits/misses per completed lookup batch",
      }),
      failures: meter.createCounter("environment_encryption.failures", {
        description: "KMS limiter failures and requests rejected because a key is unavailable",
      }),
    };
  });
}
