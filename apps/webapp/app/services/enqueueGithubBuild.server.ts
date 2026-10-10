import { type BillingClient, EnqueueBuildResponseSchema } from "@trigger.dev/platform";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";

export type EnqueueBuildError =
  | { type: "billing_not_configured" }
  | { type: "build_service_unreachable" }
  | { type: "build_rejected"; code?: string; error: string };

export type EnqueueGithubBuildOptions = { skipPromotion?: boolean; configFilePath?: string };

/** Calls the platform enqueue-build endpoint with a GitHub source; failures never surface transport details. */
export function enqueueGithubBuildWithClient(
  client: Pick<BillingClient, "fetch">,
  projectId: string,
  deploymentId: string,
  github: { commitSha: string; ref: string },
  options: EnqueueGithubBuildOptions = {},
  onFailure?: (kind: "caught" | "no_success") => void
): ResultAsync<{ buildId: string }, EnqueueBuildError> {
  return fromPromise(
    client.fetch(`/api/v1/projects/${projectId}/enqueue-build`, EnqueueBuildResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deploymentId, github, options }),
    }),
    () => {
      onFailure?.("caught");
      return { type: "build_service_unreachable" as const };
    }
  ).andThen((result) => {
    if (!result.success) {
      onFailure?.("no_success");
      return errAsync({ type: "build_rejected" as const, code: result.code, error: result.error });
    }
    return okAsync({ buildId: result.buildId });
  });
}
