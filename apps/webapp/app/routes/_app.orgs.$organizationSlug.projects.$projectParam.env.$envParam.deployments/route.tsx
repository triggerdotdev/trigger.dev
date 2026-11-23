import { throwPermissionDenied } from "~/utils/permissionDenied";
import { rbac } from "~/services/rbac.server";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";
import { resolveDeploymentOnboardingUi } from "~/v3/services/deploymentOnboardingUi.server";
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  BookOpenIcon,
  NoSymbolIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher, useLocation, useNavigate, useNavigation } from "@remix-run/react";

import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { CogIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PromoteIcon } from "~/assets/icons/PromoteIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { VercelLink } from "~/components/integrations/VercelLink";
import { DeploymentsNone, DeploymentsNoneDev } from "~/components/BlankStatePanels";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { GitMetadata } from "~/components/GitMetadata";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { DateTime } from "~/components/primitives/DateTime";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import {
  Dialog,
  DialogDescription,
  DialogContent,
  DialogHeader,
  DialogTrigger,
  DialogFooter,
} from "~/components/primitives/Dialog";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  CopyableTableCell,
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  DeploymentStatus,
  deploymentDisplayStatus,
  deploymentStatusDescription,
  deploymentStatuses,
} from "~/components/runs/v3/DeploymentStatus";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  type DeploymentListItem,
  DeploymentListPresenter,
} from "~/presenters/v3/DeploymentListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { titleCase } from "~/utils";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  docsPath,
  v3DeploymentPath,
  v3EnvironmentPath,
  v3ProjectSettingsIntegrationsPath,
} from "~/utils/pathBuilder";
import { createSearchParams } from "~/utils/searchParams";
import {
  DeploymentFilters,
  DeploymentListSearchParams,
} from "~/components/runs/v3/DeploymentFilters";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { env } from "~/env.server";
import { DialogClose } from "@radix-ui/react-dialog";
import { deploymentsAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";
import {
  CancelDeploymentDialog,
  PromoteDeploymentDialog,
  RollbackDeploymentDialog,
  UserTag,
} from "~/components/deployments/DeploymentDialogs";

export const handle: Handle = {
  agentPageContext: () => deploymentsAgentPageContext(),
};
import { pageMeta } from "~/utils/pageTitle";
import { TextLink } from "~/components/primitives/TextLink";
import { useLatchedDeploymentOnboarding } from "~/hooks/useLatchedDeploymentOnboarding";
import {
  getDeployActivityPreference,
  getTimezonePreference,
} from "~/services/preferences/uiPreferences.server";
import { DeploymentsActivityBand } from "~/components/deployments/DeployActivityViews";

export const meta = pageMeta("Deployments");

const SearchParams = z.object({
  page: z.coerce.number().optional(),
  version: z.string().optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const searchParams = createSearchParams(request.url, SearchParams);

  let page = searchParams.success ? Number(searchParams.params.get("page") ?? 1) : 1;
  const version = searchParams.success ? searchParams.params.get("version")?.toString() : undefined;

  const url = new URL(request.url);
  const parsedFilters = DeploymentListSearchParams.safeParse({
    statuses: url.searchParams.getAll("statuses"),
    branches: url.searchParams.getAll("branches"),
    search: url.searchParams.get("search") ?? undefined,
    day: url.searchParams.get("day") ?? undefined,
  });
  const [timeZone, showActivity] = await Promise.all([
    getTimezonePreference(request),
    getDeployActivityPreference(request),
  ]);

  const presenter = new DeploymentListPresenter();

  // If we have a version, find its page
  if (version) {
    try {
      page = await presenter.findPageForVersion({
        userId,
        organizationSlug,
        projectSlug: projectParam,
        environmentSlug: envParam,
        version,
      });
    } catch (error) {
      console.error("Error finding page for version", error);
      // Carry on, we'll just show the selected page
    }
  }

  try {
    const result = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      environmentSlug: envParam,
      page,
      // The version jump finds the page in the unfiltered list.
      filters: !version && parsedFilters.success ? { ...parsedFilters.data, timeZone } : undefined,
    });

    // If we have a version, find the deployment
    const selectedDeployment = version
      ? result.deployments.find((d) => d.version === version)
      : undefined;

    const autoReloadPollIntervalMs = env.DEPLOYMENTS_AUTORELOAD_POLL_INTERVAL_MS;

    // Read access is decided in the project's scope, so a role held on this project counts, as
    // on the deployment page. The write flag stays in the organization's scope, which is how the
    // promote, rollback and cancel actions authenticate. It only decides what is shown.
    const [readAuth, writeAuth] = await Promise.all([
      rbac.authenticateSession(request, {
        userId,
        organizationId: result.organizationId,
        projectId: result.projectId,
      }),
      rbac.authenticateSession(request, { userId, organizationId: result.organizationId }),
    ]);
    if (!readAuth.ok || !readAuth.ability.can("read", { type: "deployments" })) {
      throwPermissionDenied();
    }
    const canWriteDeployments = writeAuth.ok
      ? checkPermissions(writeAuth.ability, {
          canWriteDeployments: { action: "write", resource: { type: "deployments" } },
        }).canWriteDeployments
      : true;
    const redeployCutoff = new Date(
      Date.now() - env.DEPLOYMENTS_REDEPLOY_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );

    const onboarding = await resolveDeploymentOnboardingUi({
      request,
      userId,
      organizationSlug,
      projectSlug: projectParam,
      environmentSlug: envParam,
      organizationId: result.organizationId,
      projectId: result.projectId,
      environmentId: result.environmentId,
      environmentType: result.environmentType,
      url: new URL(request.url),
    });

    return typedjson({
      ...result,
      ...onboarding,
      canWriteDeployments,
      redeployCutoff,
      selectedDeployment,
      autoReloadPollIntervalMs,
      showActivity,
      timeZone,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const {
    deployments,
    currentPage,
    totalPages,
    selectedDeployment,
    connectedGithubRepository,
    environmentGitHubBranch,
    autoReloadPollIntervalMs,
    hasVercelIntegration,
    canWriteDeployments,
    redeployCutoff,
    canDeployNow,
    deployNowEnabled,
    githubConnectAvailable,
    isPlatformConfigured,
    showGitHubOnboarding: loaderShowsGitHubOnboarding,
    onboardingDetails: loaderOnboardingDetails,
    atomicVercelUrl,
    hasAnyDeployments,
    hasFilters,
    currentDeployment,
    showActivity: savedShowActivity,
    timeZone,
  } = useTypedLoaderData<typeof loader>();
  const hasDeployments = hasAnyDeployments;

  const location = useLocation();
  const navigate = useNavigate();

  // The activity grid is hidden until asked for; the choice is saved in the UI preferences cookie.
  // While the save is on its way the switch shows what was asked for.
  const activityFetcher = useFetcher();
  const requestedActivity = activityFetcher.formData?.get("show");
  const showActivity =
    typeof requestedActivity === "string" ? requestedActivity === "true" : savedShowActivity;
  const setShowActivity = (show: boolean) =>
    activityFetcher.submit(
      { show: String(show) },
      {
        method: "post",
        action: `/resources${v3EnvironmentPath(organization, project, environment)}/deployments/activity`,
      }
    );

  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true });

  const { onboarding } = useLatchedDeploymentOnboarding(
    {
      showGitHubOnboarding: loaderShowsGitHubOnboarding,
      onboardingDetails: loaderOnboardingDetails,
    },
    {
      deploymentPath: (shortCode) =>
        v3DeploymentPath(organization, project, environment, { shortCode }, 0),
      pollIntervalMs: autoReloadPollIntervalMs,
    }
  );
  const showGitHubOnboarding = !!onboarding?.showGitHubOnboarding;
  const onboardingDetails = onboarding?.onboardingDetails;

  const selectedDeploymentShortCode = selectedDeployment?.shortCode;

  // If we have a selected deployment from the version param, show it
  useEffect(() => {
    if (selectedDeploymentShortCode) {
      const searchParams = new URLSearchParams(location.search);
      searchParams.delete("version");
      searchParams.set("page", currentPage.toString());
      navigate(`${location.pathname}/${selectedDeploymentShortCode}?${searchParams.toString()}`);
    }
  }, [selectedDeploymentShortCode, location.search, location.pathname, currentPage, navigate]);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Deployments" />
        <PageAccessories>
          <WhenAgentUnavailable>
            <LinkButton
              variant={"docs/small"}
              LeadingIcon={BookOpenIcon}
              to={docsPath("/cli-deploy")}
            >
              Deployments docs
            </LinkButton>
          </WhenAgentUnavailable>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="h-full max-h-full">
          {hasDeployments && !showGitHubOnboarding ? (
            <div className="flex h-full max-h-full flex-col">
              <div className="flex items-center justify-between gap-x-2 p-2">
                <DeploymentFilters showActivity={showActivity} onShowActivity={setShowActivity} />
                <PaginationControls
                  currentPage={currentPage}
                  totalPages={totalPages}
                  showPageNumbers={false}
                />
              </div>
              {showActivity ? <DeploymentsActivityBand timeZone={timeZone} /> : null}
              <Table containerClassName="grow">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Deploy</TableHeaderCell>
                    <TableHeaderCell>Version</TableHeaderCell>
                    <TableHeaderCell
                      tooltip={
                        <div className="flex flex-col divide-y divide-grid-dimmed">
                          {deploymentStatuses.map((status) => (
                            <div
                              key={status}
                              className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1"
                            >
                              <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                                <DeploymentStatus status={status} isBuilt={false} />
                              </div>
                              <Paragraph
                                variant="extra-small"
                                className="text-wrap! text-text-dimmed"
                              >
                                {deploymentStatusDescription(status)}
                              </Paragraph>
                            </div>
                          ))}
                        </div>
                      }
                    >
                      Status
                    </TableHeaderCell>
                    <TableHeaderCell>Runtime</TableHeaderCell>
                    <TableHeaderCell>Tasks</TableHeaderCell>
                    <TableHeaderCell>Deployed at</TableHeaderCell>
                    <TableHeaderCell>Deployed by</TableHeaderCell>
                    <TableHeaderCell>External ID</TableHeaderCell>
                    {hasVercelIntegration && <TableHeaderCell>Linked</TableHeaderCell>}
                    <TableHeaderCell>Git</TableHeaderCell>
                    <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deployments.length > 0 ? (
                    deployments.map((deployment) => {
                      const path = v3DeploymentPath(
                        organization,
                        project,
                        environment,
                        deployment,
                        currentPage
                      );
                      return (
                        <TableRow key={deployment.id} className="group">
                          <TableCell to={path} isTabbableCell>
                            <div className="flex items-center gap-2">
                              <Paragraph
                                variant="extra-small"
                                className="group-hover/table-row:text-text-bright"
                              >
                                {deployment.shortCode}
                              </Paragraph>
                              {deployment.label && (
                                <Badge variant="extra-small">{titleCase(deployment.label)}</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell to={path}>{deployment.version}</TableCell>
                          <TableCell to={path}>
                            <DeploymentStatus
                              status={deploymentDisplayStatus(
                                deployment.status,
                                deployment.isSuperseded
                              )}
                              isBuilt={deployment.isBuilt}
                            />
                          </TableCell>
                          <TableCell to={path}>
                            <RuntimeIcon
                              runtime={deployment.runtime}
                              runtimeVersion={deployment.runtimeVersion}
                              withLabel
                            />
                          </TableCell>
                          <TableCell to={path}>
                            {deployment.tasksCount !== null ? deployment.tasksCount : "–"}
                          </TableCell>
                          <TableCell to={path}>
                            {deployment.deployedAt ? (
                              <DateTime date={deployment.deployedAt} />
                            ) : (
                              "–"
                            )}
                          </TableCell>
                          <TableCell to={path}>
                            {deployment.git?.source === "trigger_github_app" ? (
                              <UserTag
                                name={deployment.git.ghUsername ?? "GitHub Integration"}
                                avatarUrl={deployment.git.ghUserAvatarUrl}
                              />
                            ) : deployment.deployedBy ? (
                              <UserTag
                                name={
                                  deployment.deployedBy.name ??
                                  deployment.deployedBy.displayName ??
                                  ""
                                }
                                avatarUrl={deployment.deployedBy.avatarUrl ?? undefined}
                              />
                            ) : (
                              "–"
                            )}
                          </TableCell>
                          <DeploymentExternalIdCell
                            externalId={deployment.externalId}
                            path={path}
                          />
                          {hasVercelIntegration && (
                            <TableCell>
                              {deployment.vercelDeploymentUrl ? (
                                <div className="-ml-1 flex items-center">
                                  <VercelLink
                                    vercelDeploymentUrl={deployment.vercelDeploymentUrl}
                                  />
                                </div>
                              ) : (
                                "–"
                              )}
                            </TableCell>
                          )}
                          <TableCell>
                            <div className="-ml-1 flex items-center">
                              <GitMetadata git={deployment.git} />
                            </div>
                          </TableCell>
                          <DeploymentActionsCell
                            deployment={deployment}
                            path={path}

                            currentDeployment={currentDeployment}
                            canWriteDeployments={canWriteDeployments}
                            redeployCutoff={redeployCutoff}
                          />
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableBlankRow colSpan={hasVercelIntegration ? 11 : 10}>
                      <Paragraph className="flex items-center justify-center">
                        {hasFilters
                          ? "There are no matching deploys"
                          : "There are no deploys on this page"}
                      </Paragraph>
                    </TableBlankRow>
                  )}
                </TableBody>
              </Table>
              <div
                className={cn(
                  "-mt-px flex flex-wrap justify-end gap-2 border-t border-grid-dimmed px-3 pb-[7px] pt-[6px]",
                  connectedGithubRepository && environmentGitHubBranch && "justify-between"
                )}
              >
                {connectedGithubRepository && environmentGitHubBranch && (
                  <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap text-sm">
                    <OctoKitty className="size-4" />
                    Automatically triggered by pushes to{" "}
                    <div className="flex max-w-32 items-center gap-1 truncate rounded bg-grid-dimmed px-1 font-mono">
                      <GitBranchIcon className="size-3 shrink-0" />
                      <span className="max-w-28 truncate">{environmentGitHubBranch}</span>
                    </div>{" "}
                    in
                    <TextLink
                      href={connectedGithubRepository.repository.htmlUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      variant="secondary"
                      className="text-sm"
                    >
                      {/* truncate needs a block-level child: the link itself is inline-flex */}
                      <span className="max-w-52 truncate">
                        {connectedGithubRepository.repository.fullName}
                      </span>
                    </TextLink>
                    <LinkButton
                      variant="minimal/small"
                      LeadingIcon={CogIcon}
                      to={v3ProjectSettingsIntegrationsPath(organization, project, environment)}
                    />
                  </div>
                )}
                <PaginationControls currentPage={currentPage} totalPages={totalPages} />
              </div>
            </div>
          ) : environment.type === "DEVELOPMENT" ? (
            <MainCenteredContainer
              className={cn("max-w-prose", deployNowEnabled && "w-[calc(100%_-_3rem)]")}
            >
              <DeploymentsNoneDev enhanced={deployNowEnabled} />
            </MainCenteredContainer>
          ) : (
            <MainCenteredContainer
              variant={showGitHubOnboarding ? "centered" : "default"}
              className={cn("max-w-prose", showGitHubOnboarding && "w-[calc(100%_-_3rem)]")}
            >
              <DeploymentsNone
                showGitHubOnboarding={showGitHubOnboarding}
                onboardingDetails={onboardingDetails}
                connectedGithubRepository={connectedGithubRepository}
                environmentGitHubBranch={environmentGitHubBranch}
                deployNowEnabled={deployNowEnabled}
                githubConnectAvailable={githubConnectAvailable}
                isPlatformConfigured={isPlatformConfigured}
                canDeployNow={canDeployNow}
                atomicVercelUrl={atomicVercelUrl}
              />
            </MainCenteredContainer>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function DeploymentActionsCell({
  deployment,
  path,
  currentDeployment,
  canWriteDeployments,
  redeployCutoff,
}: {
  deployment: DeploymentListItem;
  path: string;
  currentDeployment?: { version: string };
  canWriteDeployments: boolean;
  redeployCutoff: Date;
}) {
  const location = useLocation();
  const project = useProject();

  const canBeMadeCurrent = !deployment.isCurrent && deployment.isDeployed;
  const canBeRolledBack =
    canBeMadeCurrent &&
    currentDeployment?.version &&
    compareDeploymentVersions(deployment.version, currentDeployment.version) === -1;
  const canBePromoted = canBeMadeCurrent && !canBeRolledBack;

  const finalStatuses = ["CANCELED", "DEPLOYED", "FAILED", "TIMED_OUT"];
  const canBeCanceled = !finalStatuses.includes(deployment.status);
  const showRedeploy =
    deployment.redeploySource !== null &&
    finalStatuses.includes(deployment.status) &&
    deployment.createdAt >= redeployCutoff;
  const redeployDisabledReason = canWriteDeployments
    ? undefined
    : "You don't have permission to redeploy";

  if (!canBeRolledBack && !canBePromoted && !canBeCanceled && !showRedeploy) {
    return <TableCell to={path}>{""}</TableCell>;
  }

  return (
    <TableCellMenu
      isSticky

      // oxlint-disable-next-line react/no-unstable-nested-components -- Render prop: the menu primitive passes its close handler so the redeploy dialog can dismiss the menu.
      popoverContent={(closeMenu) => (
        <>
          {canBeRolledBack &&
            (canWriteDeployments ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="small-menu-item"
                    LeadingIcon={ArrowUturnLeftIcon}
                    leadingIconClassName="text-blue-500"
                    fullWidth
                    textAlignLeft
                  >
                    Rollback
                  </Button>
                </DialogTrigger>
                <RollbackDeploymentDialog
                  projectId={project.id}
                  deploymentShortCode={deployment.shortCode}
                  redirectPath={`${location.pathname}${location.search}`}
                />
              </Dialog>
            ) : (
              <Button
                variant="small-menu-item"
                LeadingIcon={ArrowUturnLeftIcon}
                leadingIconClassName="text-blue-500"
                fullWidth
                textAlignLeft
                disabled
                tooltip="You don't have permission to roll back deployments"
              >
                Rollback
              </Button>
            ))}
          {canBePromoted &&
            (canWriteDeployments ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="small-menu-item"
                    LeadingIcon={PromoteIcon}
                    leadingIconClassName="text-blue-500"
                    fullWidth
                    textAlignLeft
                  >
                    Promote
                  </Button>
                </DialogTrigger>
                <PromoteDeploymentDialog
                  projectId={project.id}
                  deploymentShortCode={deployment.shortCode}
                  redirectPath={`${location.pathname}${location.search}`}
                />
              </Dialog>
            ) : (
              <Button
                variant="small-menu-item"
                LeadingIcon={PromoteIcon}
                leadingIconClassName="text-blue-500"
                fullWidth
                textAlignLeft
                disabled
                tooltip="You don't have permission to promote deployments"
              >
                Promote
              </Button>
            ))}
          {canBeCanceled &&
            (canWriteDeployments ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="small-menu-item"
                    LeadingIcon={NoSymbolIcon}
                    leadingIconClassName="text-error"
                    fullWidth
                    textAlignLeft
                  >
                    Cancel
                  </Button>
                </DialogTrigger>
                <CancelDeploymentDialog
                  projectId={project.id}
                  deploymentShortCode={deployment.shortCode}
                  redirectPath={`${location.pathname}${location.search}`}
                />
              </Dialog>
            ) : (
              <Button
                variant="small-menu-item"
                LeadingIcon={NoSymbolIcon}
                leadingIconClassName="text-error"
                fullWidth
                textAlignLeft
                disabled
                tooltip="You don't have permission to cancel deployments"
              >
                Cancel
              </Button>
            ))}
          {showRedeploy &&
            (redeployDisabledReason === undefined ? (
              <RedeployDeploymentDialog
                projectId={project.id}
                deployment={deployment}
                redirectPath={`${location.pathname}${location.search}`}
                onSettled={closeMenu}
              />
            ) : (
              <Button
                variant="small-menu-item"
                LeadingIcon={ArrowPathIcon}
                leadingIconClassName="text-blue-500"
                fullWidth
                textAlignLeft
                disabled
                tooltip={redeployDisabledReason}
              >
                Redeploy
              </Button>
            ))}
        </>
      )}
    />
  );
}

function RedeployDeploymentDialog({
  projectId,
  deployment,
  redirectPath,
  onSettled,
}: {
  projectId: string;
  deployment: DeploymentListItem;
  redirectPath: string;
  onSettled: () => void;
}) {
  const navigation = useNavigation();
  const [open, setOpen] = useState(false);

  const formAction = `/resources/${projectId}/deployments/${deployment.shortCode}/redeploy`;
  const formId = `redeploy-${deployment.shortCode}`;
  const isLoading = navigation.formAction === formAction;

  // The source row stays eligible after a redeploy, so the dialog never unmounts; close it
  // once the submission has settled (the toast carries the outcome).
  const wasLoading = useRef(false);
  useEffect(() => {
    if (wasLoading.current && !isLoading) {
      setOpen(false);
      onSettled();
    }
    wasLoading.current = isLoading;
  }, [isLoading, onSettled]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={ArrowPathIcon}
          leadingIconClassName="text-blue-500"
          fullWidth
          textAlignLeft
        >
          Redeploy
        </Button>
      </DialogTrigger>
      <DialogContent key="redeploy">
        <DialogHeader>Redeploy</DialogHeader>
        <DialogDescription>
          {deployment.redeploySource === "github" && deployment.git ? (
            <>
              A new deployment will rebuild commit{" "}
              <InlineCode variant="extra-small">{deployment.git.shortSha}</InlineCode> from branch{" "}
              <InlineCode variant="extra-small">{deployment.git.branchName}</InlineCode>.
            </>
          ) : deployment.redeploySource === "bundle" ? (
            <>
              A new deployment will be created from the bundle uploaded for deployment{" "}
              <InlineCode variant="extra-small">{deployment.shortCode}</InlineCode>, with the
              build-time environment variables it was deployed with.
            </>
          ) : (
            <>
              A new deployment will be created from the source files of deployment{" "}
              <InlineCode variant="extra-small">{deployment.shortCode}</InlineCode>.
            </>
          )}
        </DialogDescription>
        <CheckboxWithLabel
          name="promote"
          value="on"
          form={formId}
          variant="simple/small"
          defaultChecked
          label="Promote deployment automatically"
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="tertiary/medium">Cancel</Button>
          </DialogClose>
          <Form id={formId} action={formAction} method="post">
            <Button
              type="submit"
              name="redirectUrl"
              value={redirectPath}
              variant="primary/medium"
              LeadingIcon={isLoading ? SpinnerWhite : ArrowPathIcon}
              disabled={isLoading}
              shortcut={{ modifiers: ["mod"], key: "enter" }}
            >
              {isLoading ? "Redeploying..." : "Redeploy"}
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeploymentExternalIdCell({
  externalId,
  path,
}: {
  externalId: string | null;
  path: string;
}) {
  if (!externalId) {
    return <TableCell to={path}>–</TableCell>;
  }

  return (
    <CopyableTableCell to={path} className="font-mono" value={externalId}>
      {externalId.length > 12 ? `${externalId.slice(0, 12)}…` : externalId}
    </CopyableTableCell>
  );
}
