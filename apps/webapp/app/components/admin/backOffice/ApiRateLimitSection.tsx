import {
  RateLimitSection,
  type EffectiveRateLimit,
} from "./RateLimitSection";

export const API_RATE_LIMIT_INTENT = "set-rate-limit";
export const API_RATE_LIMIT_SAVED_VALUE = "rate-limit";

type FieldErrors = Record<string, string[] | undefined> | null;

type Props = {
  effective: EffectiveRateLimit;
  errors: FieldErrors;
  savedJustNow: boolean;
  isSubmitting: boolean;
};

export function ApiRateLimitSection(props: Props) {
  return (
    <RateLimitSection
      title="API rate limit"
      intent={API_RATE_LIMIT_INTENT}
      {...props}
    />
  );
}
