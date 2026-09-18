import { cn } from "~/utils/cn";
import type { ReactNode } from "react";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import { InlineCode } from "~/components/code/InlineCode";
import { SettingsRow } from "~/components/primitives/SettingsLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { LinkButton } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { VercelAtomicDeploymentNotice } from "./VercelAtomicDeploymentNotice";

const statusTitles: Record<WorkerDeploymentStatus, string> = {
  PENDING: "Your deployment is queued",
  INSTALLING: "Installing dependencies",
  BUILDING: "Building your tasks",
  DEPLOYING: "Deploying your tasks",
  DEPLOYED: "Your tasks are deployed",
  FAILED: "Your deployment failed",
  CANCELED: "Your deployment was canceled",
  TIMED_OUT: "Your deployment timed out",
};

export type OnboardingBuild = {
  shortCode: string;
  status: WorkerDeploymentStatus;
  href: string;
  errorMessage?: string;
};

export function GitHubDeploymentOnboarding({
  connection,
  branch,
  canDeploy,
  settingsDirty = false,
  settingsSaving = false,
  repositoryConnected = !!branch,
  deployAction,
  build,
  logs,
  help,
  requestError,
  historyHref,
  buildErrors = [],
  atomicVercelUrl,
  previewEnvironment = false,
  previewParent = false,
}: {
  connection: ReactNode;
  branch?: string;
  canDeploy: boolean;
  settingsDirty?: boolean;
  settingsSaving?: boolean;
  repositoryConnected?: boolean;
  deployAction?: ReactNode;
  build?: OnboardingBuild;
  logs?: ReactNode;
  help?: ReactNode;
  requestError?: string;
  historyHref?: string;
  buildErrors?: string[];
  atomicVercelUrl?: string;
  previewEnvironment?: boolean;
  previewParent?: boolean;
}) {
  const failed = build && ["FAILED", "CANCELED", "TIMED_OUT"].includes(build.status);
  const errors = [
    ...new Set([build?.errorMessage, ...buildErrors].filter((error): error is string => !!error)),
  ];
  return (
    <div className="min-w-0" data-testid="github-deployment-onboarding">
      {connection}
      {atomicVercelUrl && <VercelAtomicDeploymentNotice vercelUrl={atomicVercelUrl} />}
      {(!atomicVercelUrl || build) && (
        <SettingsRow
          className={cn(
            "[&>div:first-child]:min-w-0 [&_code]:break-all",
            build
              ? "flex-nowrap gap-3 [&>div:last-child]:min-w-0 [&>div:last-child]:flex-1 [&>div:last-child]:justify-end"
              : "flex-wrap gap-x-16 gap-y-4 [&>div:first-child]:basis-64"
          )}
          bordered={false}
          titleClassName={failed ? "text-error" : undefined}
          title={build ? statusTitles[build.status] : "Deploy your tasks"}
          description={
            build ? undefined : (
              <>
                {previewParent ? (
                  "Enable preview deployments in GitHub settings and push to a branch to create its preview environment. Select that branch environment to deploy again."
                ) : branch ? (
                  <>
                    Deploy the latest commit on{" "}
                    <InlineCode variant="extra-small">{branch}</InlineCode>, or push a new commit to{" "}
                    deploy automatically.
                  </>
                ) : previewEnvironment && repositoryConnected ? (
                  "Enable preview deployments in GitHub settings to deploy this branch."
                ) : repositoryConnected ? (
                  "Choose a tracked branch in GitHub settings to start your first deployment."
                ) : (
                  "Connect a repository and choose a tracked branch to start your first deployment."
                )}
                {requestError && (
                  <span className="mt-2 block text-error" role="alert">
                    {requestError}
                  </span>
                )}
              </>
            )
          }
          action={
            build ? (
              <div className="flex min-w-0 items-center justify-end gap-6">
                <Paragraph variant="extra-small" className="min-w-0 truncate">
                  Deployment <InlineCode variant="extra-small">{build.shortCode}</InlineCode>
                </Paragraph>
                <LinkButton className="shrink-0" variant="secondary/small" to={build.href}>
                  {failed ? "View failed deployment" : "View deployment"}
                </LinkButton>
              </div>
            ) : canDeploy && branch ? (
              <fieldset disabled={settingsDirty}>{deployAction}</fieldset>
            ) : undefined
          }
        />
      )}
      {build && (
        <div className="space-y-4">
          {logs}
          {(failed || errors.length > 0) && (
            <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-grid-dimmed pb-4">
              <div className="min-w-0 flex-1 basis-64 space-y-2">
                <Paragraph variant="small">
                  Check the build logs to find out what went wrong.
                </Paragraph>
                {errors.length > 0 && (
                  <ul role="alert" className="space-y-1 text-xs text-error">
                    {errors.map((error) => (
                      <li key={error} className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="size-1.5 shrink-0 rounded-full bg-error"
                        />
                        <span className="min-w-0 break-words">{error}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {help}
            </div>
          )}
        </div>
      )}
      <div
        className={cn(
          "flex items-center justify-between gap-4",
          build && logs ? "mt-3" : "border-t border-grid-dimmed pt-4"
        )}
      >
        <Paragraph variant="extra-small" className="min-w-0 flex-1">
          You can leave this page and come back. It updates automatically.
        </Paragraph>
        <div className="flex shrink-0 items-center gap-4">
          {/* Reserve the label's space so autosave never adds a row or moves the footer. */}
          <span role="status" aria-live="polite" className="min-w-28 text-xs text-text-dimmed">
            <span
              className={cn(
                "flex items-center justify-end gap-1.5",
                !settingsSaving && "invisible"
              )}
            >
              <Spinner className="size-3 shrink-0" color="blue" />
              Saving changes…
            </span>
          </span>
          {historyHref && (
            <LinkButton variant="secondary/small" to={historyHref}>
              All deployments
            </LinkButton>
          )}
        </div>
      </div>
    </div>
  );
}
