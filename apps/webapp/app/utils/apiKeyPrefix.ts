import type { RuntimeEnvironmentType } from "@trigger.dev/database";

export function apiKeyPrefix(environmentType: RuntimeEnvironmentType): string {
  switch (environmentType) {
    case "DEVELOPMENT":
      return "tr_dev_";
    case "STAGING":
      return "tr_stg_";
    case "PRODUCTION":
      return "tr_prod_";
    case "PREVIEW":
      return "tr_preview_";
  }
}

/** Stands in for an API key's secret, e.g. in env var examples: `tr_prod_sk_…` */
export function secretKeyPlaceholder(environmentType: RuntimeEnvironmentType): string {
  return `${apiKeyPrefix(environmentType)}sk_…`;
}
