import {
  RateLimitSection,
  type RateLimitWrapperProps,
} from "./RateLimitSection";

export const API_RATE_LIMIT_INTENT = "set-rate-limit";
export const API_RATE_LIMIT_SAVED_VALUE = "rate-limit";

export function ApiRateLimitSection(props: RateLimitWrapperProps) {
  return (
    <RateLimitSection
      title="API rate limit"
      intent={API_RATE_LIMIT_INTENT}
      {...props}
    />
  );
}
