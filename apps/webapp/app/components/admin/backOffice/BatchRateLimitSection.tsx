import {
  RateLimitSection,
  type EffectiveRateLimit,
} from "./RateLimitSection";

export const BATCH_RATE_LIMIT_INTENT = "set-batch-rate-limit";
export const BATCH_RATE_LIMIT_SAVED_VALUE = "batch-rate-limit";

type FieldErrors = Record<string, string[] | undefined> | null;

type Props = {
  effective: EffectiveRateLimit;
  errors: FieldErrors;
  savedJustNow: boolean;
  isSubmitting: boolean;
};

export function BatchRateLimitSection(props: Props) {
  return (
    <RateLimitSection
      title="Batch rate limit"
      intent={BATCH_RATE_LIMIT_INTENT}
      {...props}
    />
  );
}
