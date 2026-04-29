import {
  RateLimitSection,
  type RateLimitWrapperProps,
} from "./RateLimitSection";

export const BATCH_RATE_LIMIT_INTENT = "set-batch-rate-limit";
export const BATCH_RATE_LIMIT_SAVED_VALUE = "batch-rate-limit";

export function BatchRateLimitSection(props: RateLimitWrapperProps) {
  return (
    <RateLimitSection
      title="Batch rate limit"
      intent={BATCH_RATE_LIMIT_INTENT}
      {...props}
    />
  );
}
