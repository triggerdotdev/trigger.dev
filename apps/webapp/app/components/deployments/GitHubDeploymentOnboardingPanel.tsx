import { useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useState, type ReactNode } from "react";
import { AskAgentButton } from "~/components/dashboard-agent/AskAgentButton";
import { Button } from "~/components/primitives/Buttons";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import {
  useOnboardingDeploymentLogs,
  type DeploymentEventStream,
} from "~/hooks/useOnboardingDeploymentLogs";
import { deployNowPath } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deploy-now";
import { OnboardingDeploymentLogs } from "./OnboardingDeploymentLogs";
import { GitHubDeploymentOnboarding, type OnboardingBuild } from "./GitHubDeploymentOnboarding";

export function GitHubDeploymentOnboardingPanel({
  renderConnection,
  branch,
  canDeploy,
  repositoryConnected,
  build,
  eventStream,
  historyHref,
  organizationSlug,
  projectSlug,
  environmentSlug,
  atomicVercelUrl,
  previewEnvironment,
  previewParent,
}: {
  renderConnection: (
    onSettingsDirty: (dirty: boolean) => void,
    onSettingsSaving: (saving: boolean) => void
  ) => ReactNode;
  branch?: string;
  canDeploy: boolean;
  repositoryConnected: boolean;
  build?: OnboardingBuild;
  eventStream?: DeploymentEventStream;
  historyHref: string;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  atomicVercelUrl?: string;
  previewEnvironment?: boolean;
  previewParent?: boolean;
}) {
  const { logs, isStreaming, streamError, retry } = useOnboardingDeploymentLogs({
    eventStream,
    status: build?.status ?? "PENDING",
  });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const fetcher = useFetcher<{ ok: boolean; code?: string; vercelUrl?: string }>();
  const revalidator = useRevalidator();
  const [delayed, setDelayed] = useState(false);
  const submitting = fetcher.state !== "idle";
  const accepted = fetcher.data?.ok === true;
  useEffect(() => {
    if (!accepted || build) return;
    const timer = setTimeout(() => setDelayed(true), 30_000);
    return () => clearTimeout(timer);
  }, [accepted, build]);

  return (
    <GitHubDeploymentOnboarding
      connection={renderConnection(setSettingsDirty, setSettingsSaving)}
      settingsDirty={settingsDirty}
      settingsSaving={settingsSaving}
      branch={branch}
      canDeploy={canDeploy}
      previewEnvironment={previewEnvironment}
      previewParent={previewParent}
      atomicVercelUrl={
        atomicVercelUrl ??
        (fetcher.data?.code === "ATOMIC_PRODUCTION_REQUIRES_VERCEL"
          ? fetcher.data.vercelUrl
          : undefined)
      }
      repositoryConnected={repositoryConnected}
      build={build}
      historyHref={build ? historyHref : undefined}
      requestError={
        fetcher.data?.ok === false && !submitting && !build
          ? "Couldn't start the deployment. Try again."
          : undefined
      }
      deployAction={
        accepted && !submitting ? (
          <div
            className="flex max-w-56 flex-col items-start gap-2 text-xs text-text-dimmed"
            role="status"
          >
            {delayed
              ? "Your request was accepted, but the deployment hasn't appeared yet."
              : "Request accepted. Waiting for the deployment to appear…"}
            {delayed && (
              <Button
                variant="secondary/small"
                disabled={revalidator.state !== "idle"}
                onClick={() => revalidator.revalidate()}
              >
                Check again
              </Button>
            )}
          </div>
        ) : (
          <fetcher.Form
            method="post"
            action={deployNowPath(organizationSlug, projectSlug, environmentSlug)}
          >
            <Button
              type="submit"
              variant="primary/small"
              disabled={submitting}
              LeadingIcon={submitting ? SpinnerWhite : undefined}
            >
              {submitting ? "Starting deployment…" : "Deploy now"}
            </Button>
          </fetcher.Form>
        )
      }
      buildErrors={logs.filter((log) => log.level === "error").map((log) => log.message)}
      logs={
        build && (
          <div>
            <OnboardingDeploymentLogs
              compact
              logs={logs}
              isStreaming={isStreaming}
              streamError={
                eventStream
                  ? streamError
                  : "Build logs are currently unavailable. You can still open the deployment for details."
              }
            />
            {streamError && (
              <Button className="mt-2" variant="secondary/small" onClick={retry}>
                Reload logs
              </Button>
            )}
          </div>
        )
      }
      help={
        build && (
          <AskAgentButton
            label="Ask Trigger"
            variant="ask-trigger/small"
            prompt={`Help me diagnose deployment ${build.shortCode} in environment ${environmentSlug}, project ${projectSlug}, organization ${organizationSlug}. Deployment details: ${build.href}`}
          />
        )
      }
    />
  );
}
