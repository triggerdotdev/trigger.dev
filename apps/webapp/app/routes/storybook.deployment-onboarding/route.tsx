import { DeploymentOnboardingFrame } from "~/components/deployments/DeploymentOnboardingFrame";
import { ClientTabsContent } from "~/components/primitives/ClientTabs";
import {
  GitHubBranchTracking,
  GitHubPermissionTooltip,
} from "~/components/deployments/GitHubBranchTracking";
import { Input } from "~/components/primitives/Input";
import { Switch } from "~/components/primitives/Switch";
import { GitBranchIcon } from "lucide-react";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import { GitHubDeploymentOnboarding } from "~/components/deployments/GitHubDeploymentOnboarding";
import {
  GitHubOnboardingConnection,
  type GitHubConnectionState,
} from "~/components/deployments/GitHubOnboardingConnection";
import { OnboardingDeploymentLogs } from "~/components/deployments/OnboardingDeploymentLogs";
import type { DeploymentLogEntry } from "~/components/runs/v3/deploymentLogsCache";
import { Button } from "~/components/primitives/Buttons";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { StoryPage, StorySection } from "../storybook/StoryKit";

const repository = {
  fullName: "triggerdotdev/customer-tasks",
  htmlUrl: "https://github.com/triggerdotdev",
};
const buildLogs: DeploymentLogEntry[] = [
  "Cloning repository…",
  "Checking out commit 7e8bc90 on release/production",
  "Installing dependencies with pnpm",
  "Packages: +184",
  "Dependencies installed",
  "Reading trigger.config.ts",
  "Building task entry points",
  "Bundling 12 tasks…",
].map((message, i) => ({
  timestamp: new Date(Date.UTC(2026, 8, 15, 10, 32, i)),
  message,
  level: "info",
}));

type Scenario = {
  title: string;
  connection?: GitHubConnectionState;
  status?: WorkerDeploymentStatus;
  denied?: boolean;
  noBranch?: boolean;
  submitting?: boolean;
  error?: string;
  disconnected?: boolean;
  noCredentials?: boolean;
  long?: boolean;
  noAgent?: boolean;
  upgradeRequired?: boolean;
  previewOff?: boolean;
  settingsDirty?: boolean;
  settingsError?: boolean;
  githubDenied?: boolean;
  atomicProduction?: boolean;
  detail?:
    | "manage"
    | "production"
    | "staging"
    | "preview"
    | "long-repo"
    | "short-repo"
    | "wrapping";
};
export const scenarios: Scenario[] = [
  { title: "Loading connection", connection: "loading" },
  { title: "Slow connection lookup", connection: "slow" },
  { title: "Install GitHub", connection: "install" },
  { title: "App installed · choose repository", connection: "connect" },
  { title: "Ready to deploy" },
  { title: "Atomic production · deploy through Vercel", atomicProduction: true },
  { title: "Paid environments · branch tracking" },
  { title: "Staging and Preview · upgrade required", upgradeRequired: true },
  { title: "Preview deployments disabled", previewOff: true },
  { title: "Saving branch settings", settingsDirty: true },
  { title: "Branch settings save failed", settingsError: true },
  { title: "No GitHub management permission", githubDenied: true },
  { title: "Choose a tracked branch", noBranch: true },
  { title: "No deployment permission", denied: true },
  { title: "Connection lookup failed", connection: "error" },
  { title: "Starting deployment", submitting: true },
  {
    title: "Request failed · try again",
    error: "Couldn't start the deployment. Try again, or deploy using the CLI.",
  },
  { title: "Queued · waiting for build logs", status: "PENDING" },
  { title: "Installing", status: "INSTALLING" },
  { title: "Building", status: "BUILDING" },
  { title: "Deploying", status: "DEPLOYING" },
  { title: "Logs disconnected", status: "BUILDING", disconnected: true },
  { title: "Logs unavailable", status: "PENDING", noCredentials: true },
  { title: "Build failed", status: "FAILED" },
  { title: "Build failed · agent unavailable", status: "FAILED", noAgent: true },
  { title: "Canceled", status: "CANCELED" },
  { title: "Timed out", status: "TIMED_OUT" },
  { title: "Successful · returns to deployment history", status: "DEPLOYED" },
  { title: "Long repository and branch names", long: true },
  { title: "GitHub unavailable · use another tab", connection: "unavailable" },
  { title: "Manage permission tooltip", detail: "manage" },
  { title: "Production branch permission tooltip", detail: "production" },
  { title: "Staging branch permission tooltip", detail: "staging" },
  { title: "Preview switch permission tooltip", detail: "preview" },
  { title: "Truncated repository tooltip", detail: "long-repo" },
  { title: "Short repository without tooltip", detail: "short-repo" },
  { title: "Description wrapping comparison", detail: "wrapping" },
];

export default function DeploymentOnboardingStory() {
  return (
    <StoryPage
      title="GitHub deployment onboarding"
      description="Production components with static connection, permission, request and build states. Feature off or platform unavailable retains the existing onboarding; success returns to the normal deployment list."
      componentNames={[
        "GitHubDeploymentOnboarding.tsx",
        "GitHubOnboardingConnection.tsx",
        "GitHubBranchTracking.tsx",
        "OnboardingDeploymentLogs.tsx",
      ]}
    >
      {scenarios.map((scenario) => (
        <StorySection key={scenario.title} title={scenario.title}>
          <div
            className="max-w-[42rem] rounded-md border border-grid-dimmed bg-background-bright p-5"
            data-scenario={scenario.title}
          >
            <ScenarioView scenario={scenario} />
          </div>
        </StorySection>
      ))}
    </StoryPage>
  );
}

export function ScenarioView({ scenario }: { scenario: Scenario }) {
  if (scenario.detail) return <DetailPreview detail={scenario.detail} />;
  const connection = scenario.connection ?? "connected";
  const connected = connection === "connected";
  const branch =
    connected && !scenario.noBranch
      ? scenario.long
        ? "release/customer-onboarding-with-a-very-long-descriptive-branch-name"
        : "release/production"
      : undefined;
  const repo = scenario.long
    ? {
        ...repository,
        fullName:
          "organization-with-a-long-name/customer-onboarding-and-background-processing-tasks",
      }
    : repository;
  const connectionAction =
    connection === "install"
      ? "Install GitHub app"
      : connection === "connect"
        ? "Connect repository"
        : connection === "error" || connection === "slow"
          ? "Try again"
          : connected
            ? "Manage"
            : undefined;
  const logs =
    scenario.status === "FAILED"
      ? [
          ...buildLogs,
          {
            timestamp: new Date("2026-09-15T10:32:08Z"),
            level: "error" as const,
            message: "Missing required environment variable: DATABASE_URL",
          },
        ]
      : scenario.status === "PENDING"
        ? []
        : buildLogs;
  return (
    <DeploymentOnboardingFrame
      title="Production"
      environment={{ type: "PRODUCTION" }}
      help={!scenario.noAgent && <Button variant="ask-trigger/small">Ask Trigger</Button>}
    >
      <ClientTabsContent value="github">
        <GitHubDeploymentOnboarding
          settingsDirty={scenario.settingsDirty || scenario.settingsError}
          settingsSaving={!!scenario.settingsDirty && !scenario.settingsError}
          connection={
            <>
              <GitHubOnboardingConnection
                state={connection}
                repository={repo}
                action={
                  connectionAction && (
                    <GitHubPermissionTooltip denied={!!scenario.githubDenied}>
                      <Button variant="secondary/small" disabled={scenario.githubDenied}>
                        {connectionAction}
                      </Button>
                    </GitHubPermissionTooltip>
                  )
                }
              />
              {connected && <BranchTrackingPreview scenario={scenario} branch={branch} />}
            </>
          }
          branch={branch}
          canDeploy={connected && !scenario.denied}
          atomicVercelUrl={
            scenario.atomicProduction ? "https://vercel.com/triggerdotdev/customer-app" : undefined
          }
          repositoryConnected={connected}
          deployAction={
            <Button
              variant="primary/small"
              disabled={scenario.submitting}
              LeadingIcon={scenario.submitting ? SpinnerWhite : undefined}
            >
              {scenario.submitting ? "Starting deployment…" : "Deploy now"}
            </Button>
          }
          requestError={scenario.error}
          build={
            scenario.status
              ? {
                  shortCode: "dp_7e8bc90",
                  status: scenario.status,
                  href: "#deployment",
                  errorMessage:
                    scenario.status === "FAILED"
                      ? "Missing required environment variable: DATABASE_URL"
                      : undefined,
                }
              : undefined
          }
          buildErrors={
            scenario.status
              ? logs.filter((log) => log.level === "error").map((log) => log.message)
              : []
          }
          logs={
            scenario.status && (
              <OnboardingDeploymentLogs
                compact
                logs={logs}
                isStreaming={
                  !["FAILED", "CANCELED", "TIMED_OUT", "DEPLOYED"].includes(scenario.status) &&
                  !scenario.disconnected &&
                  !scenario.noCredentials
                }
                streamError={
                  scenario.disconnected
                    ? "Log connection interrupted. Reconnecting…"
                    : scenario.noCredentials
                      ? "Build logs are currently unavailable. You can still open the deployment for details."
                      : null
                }
              />
            )
          }
          help={!scenario.noAgent && <Button variant="ask-trigger/small">Ask Trigger</Button>}
          historyHref={scenario.status ? "#history" : undefined}
        />
      </ClientTabsContent>
      <ClientTabsContent value="cli">
        <p className="text-sm text-text-dimmed">
          Run the CLI deploy command to deploy your tasks to Production.
        </p>
      </ClientTabsContent>
      <ClientTabsContent value="github-actions">
        <p className="text-sm text-text-dimmed">Deploy your tasks using GitHub Actions.</p>
      </ClientTabsContent>
    </DeploymentOnboardingFrame>
  );
}

export function BranchTrackingPreview({
  scenario,
  branch,
}: {
  scenario: Scenario;
  branch?: string;
}) {
  return (
    <div>
      <GitHubBranchTracking
        canManageGithub={!scenario.githubDenied}
        productionInput={
          <Input
            aria-label="Production tracking branch"
            name="productionBranch"
            defaultValue={scenario.settingsDirty ? "release/next" : (branch ?? "")}
            disabled={scenario.githubDenied}
            placeholder="none"
            variant="medium"
            className="truncate font-mono"
            containerClassName="w-64"
            icon={GitBranchIcon}
          />
        }
        stagingInput={
          <Input
            aria-label="Staging tracking branch"
            name="stagingBranch"
            defaultValue=""
            disabled={scenario.githubDenied}
            placeholder="none"
            variant="medium"
            className="truncate font-mono"
            containerClassName="w-64"
            icon={GitBranchIcon}
          />
        }
        previewInput={
          <Switch
            aria-label="Enable preview deployments"
            name="previewDeploymentsEnabled"
            defaultChecked={!scenario.previewOff}
            disabled={scenario.githubDenied}
            variant="medium"
          />
        }
        stagingEnvironmentEnabled={!scenario.upgradeRequired}
        previewEnvironmentEnabled={!scenario.upgradeRequired}
        previewDeploymentsEnabled={!scenario.previewOff && !scenario.upgradeRequired}
        billingPath="#billing"
      />
      {scenario.settingsError && (
        <div
          className="flex items-center justify-between gap-6 border-b border-grid-dimmed py-3 text-xs"
          role="status"
        >
          <span className="text-error">Production tracking branch not found</span>
          {scenario.settingsError && <Button variant="secondary/small">Retry</Button>}
        </div>
      )}
    </div>
  );
}

/** Explicit open-state illustrations: visible in the offline gallery without React hydration. */
function DetailPreview({ detail }: { detail: NonNullable<Scenario["detail"]> }) {
  const permission = "You don't have permission to manage GitHub settings.";
  if (detail === "wrapping") {
    return (
      <div className="space-y-6">
        <p className="text-xs text-text-dimmed">
          Actual deployment rows constrained to three widths. Widths shrink to fit on narrow
          screens.
        </p>
        {[592, 448, 286].map((width) => (
          <div key={width} style={{ width, maxWidth: "100%" }}>
            <p className="border-b border-grid-dimmed pb-2 text-xs text-text-dimmed">
              Up to {width}px
            </p>
            <GitHubDeploymentOnboarding
              connection={null}
              branch="release/production"
              canDeploy
              deployAction={<Button variant="primary/small">Deploy now</Button>}
            />
          </div>
        ))}
      </div>
    );
  }
  if (detail === "long-repo" || detail === "short-repo") {
    const fullName =
      detail === "long-repo"
        ? "organization-with-a-long-name/customer-onboarding-and-background-processing-tasks"
        : "acme/tasks";
    return (
      <div>
        <p className="mb-4 text-xs text-text-dimmed">
          {detail === "long-repo"
            ? "Hover preview: a clipped repository name reveals its full value."
            : "No overflow: the full repository name is visible and no tooltip is shown."}
        </p>
        {detail === "long-repo" && <OpenTooltipPreview>{fullName}</OpenTooltipPreview>}
        <GitHubOnboardingConnection
          state="connected"
          repository={{ fullName, htmlUrl: "https://github.com/triggerdotdev" }}
          action={<Button variant="secondary/small">Manage</Button>}
        />
      </div>
    );
  }
  const label =
    detail === "manage"
      ? "Repository connected"
      : detail === "preview"
        ? "Preview"
        : detail === "staging"
          ? "Staging tracking branch"
          : "Production tracking branch";
  return (
    <div>
      <p className="mb-4 text-xs text-text-dimmed">
        Hover preview · GitHub management permission denied
      </p>
      <OpenTooltipPreview>{permission}</OpenTooltipPreview>
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b border-grid-dimmed py-4">
        <span className="text-sm text-text-bright">{label}</span>
        <GitHubPermissionTooltip denied>
          {detail === "manage" ? (
            <Button disabled variant="secondary/small">
              Manage
            </Button>
          ) : detail === "preview" ? (
            <Switch
              disabled
              defaultChecked
              aria-label="Enable preview deployments"
              variant="medium"
            />
          ) : (
            <Input
              disabled
              aria-label={label}
              defaultValue={detail === "staging" ? "staging" : "release/production"}
              icon={GitBranchIcon}
              variant="medium"
              className="truncate font-mono"
              containerClassName="w-64"
            />
          )}
        </GitHubPermissionTooltip>
      </div>
    </div>
  );
}

function OpenTooltipPreview({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 flex justify-end" data-testid="illustrated-open-tooltip">
      {/* Same surface styles as TooltipContent; in-flow so exported snapshots retain the bubble. */}
      <div
        role="note"
        className="max-w-80 break-words rounded border border-grid-bright bg-background-bright px-3 py-2 text-xs text-text-bright shadow-md [overflow-wrap:anywhere]"
      >
        {children}
      </div>
    </div>
  );
}
