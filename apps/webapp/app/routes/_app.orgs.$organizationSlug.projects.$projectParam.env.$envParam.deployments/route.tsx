import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  BookOpenIcon,
  NoSymbolIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  type MetaFunction,
  Outlet,
  useLocation,
  useNavigate,
  useNavigation,
  useParams,
} from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { CogIcon, GitBranchIcon } from "lucide-react";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PromoteIcon } from "~/assets/icons/PromoteIcon";
import { DeploymentsNone, DeploymentsNoneDev } from "~/components/BlankStatePanels";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { GitMetadata } from "~/components/GitMetadata";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
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
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import {
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
  v3ProjectSettingsPath,
} from "~/utils/pathBuilder";
import { createSearchParams } from "~/utils/searchParams";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { env } from "~/env.server";
import { DialogClose } from "@radix-ui/react-dialog";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Deployments | Trigger.dev`,
    },
  ];
};

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
    });

    // If we have a version, find the deployment
    const selectedDeployment = version
      ? result.deployments.find((d) => d.version === version)
      : undefined;

    const autoReloadPollIntervalMs = env.DEPLOYMENTS_AUTORELOAD_POLL_INTERVAL_MS;

    return typedjson({ ...result, selectedDeployment, autoReloadPollIntervalMs });
  } catch (error) {
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
  } = useTypedLoaderData<typeof loader>();
  const hasDeployments = totalPages > 0;

  const { deploymentParam } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true });

  // If we have a selected deployment from the version param, show it
  useEffect(() => {
    if (selectedDeployment && !deploymentParam) {
      const searchParams = new URLSearchParams(location.search);
      searchParams.delete("version");
      searchParams.set("page", currentPage.toString());
      navigate(`${location.pathname}/${selectedDeployment.shortCode}?${searchParams.toString()}`);
    }
  }, [selectedDeployment, deploymentParam, location.search]);

  const currentDeployment = deployments.find((d) => d.isCurrent);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Deployments" />
        <PageAccessories>
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/cli-deploy")}
          >
            Deployments docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="h-full max-h-full">
          <ResizablePanel id="deployments-main" min="100px" className="max-h-full">
            {hasDeployments ? (
              <div className="flex h-full max-h-full flex-col">
                <Table containerClassName="border-t-0 grow">
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
                                  className="!text-wrap text-text-dimmed"
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
                        const isSelected = deploymentParam === deployment.shortCode;
                        return (
                          <TableRow key={deployment.id} className="group" isSelected={isSelected}>
                            <TableCell to={path} isTabbableCell isSelected={isSelected}>
                              <div className="flex items-center gap-2">
                                <Paragraph variant="extra-small">{deployment.shortCode}</Paragraph>
                                {deployment.label && (
                                  <Badge variant="extra-small">{titleCase(deployment.label)}</Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell to={path} isSelected={isSelected}>
                              {deployment.version}
                            </TableCell>
                            <TableCell to={path} isSelected={isSelected}>
                              <DeploymentStatus
                                status={deployment.status}
                                isBuilt={deployment.isBuilt}
                              />
                            </TableCell>
                            <TableCell to={path} isSelected={isSelected}>
                              <RuntimeIcon
                                runtime={deployment.runtime}
                                runtimeVersion={deployment.runtimeVersion}
                              />
                            </TableCell>
                            <TableCell to={path} isSelected={isSelected}>
                              {deployment.tasksCount !== null ? deployment.tasksCount : "–"}
                            </TableCell>
                            <TableCell to={path} isSelected={isSelected}>
                              {deployment.deployedAt ? (
                                <DateTime date={deployment.deployedAt} />
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCell to={path} isSelected={isSelected}>
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
                            <TableCell isSelected={isSelected}>
                              <div className="-ml-1 flex items-center">
                                <GitMetadata git={deployment.git} />
                              </div>
                            </TableCell>
                            <DeploymentActionsCell
                              deployment={deployment}
                              path={path}
                              isSelected={isSelected}
                              currentDeployment={currentDeployment}
                            />
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableBlankRow colSpan={8}>
                        <Paragraph className="flex items-center justify-center">
                          No deploys match your filters
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
                      <a
                        href={connectedGithubRepository.repository.htmlUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="max-w-52 truncate text-sm text-text-dimmed underline transition-colors hover:text-text-bright"
                      >
                        {connectedGithubRepository.repository.fullName}
                      </a>
                      <LinkButton
                        variant="minimal/small"
                        LeadingIcon={CogIcon}
                        to={v3ProjectSettingsPath(organization, project, environment)}
                      />
                    </div>
                  )}
                  <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                </div>
              </div>
            ) : environment.type === "DEVELOPMENT" ? (
              <MainCenteredContainer className="max-w-prose">
                <DeploymentsNoneDev />
              </MainCenteredContainer>
            ) : (
              <MainCenteredContainer className="max-w-prose">
                <DeploymentsNone />
              </MainCenteredContainer>
            )}
          </ResizablePanel>

          {deploymentParam && (
            <>
              <ResizableHandle id="deployments-handle" />
              <ResizablePanel id="deployments-inspector" min="400px" max="700px">
                <Outlet />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

export function UserTag({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  return (
    <div className="flex items-center gap-1">
      <UserAvatar avatarUrl={avatarUrl} name={name} className="h-4 w-4" />
      <Paragraph variant="extra-small">{name}</Paragraph>
    </div>
  );
}

function DeploymentActionsCell({
  deployment,
  path,
  isSelected,
  currentDeployment,
}: {
  deployment: DeploymentListItem;
  path: string;
  isSelected: boolean;
  currentDeployment?: DeploymentListItem;
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

  if (!canBeRolledBack && !canBePromoted && !canBeCanceled) {
    return (
      <TableCell to={path} isSelected={isSelected}>
        {""}
      </TableCell>
    );
  }

  return (
    <TableCellMenu
      isSticky
      isSelected={isSelected}
      popoverContent={
        <>
          {canBeRolledBack && (
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
          )}
          {canBePromoted && (
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
          )}
          {canBeCanceled && (
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
          )}
        </>
      }
    />
  );
}

type RollbackDeploymentDialogProps = {
  projectId: string;
  deploymentShortCode: string;
  redirectPath: string;
};

function RollbackDeploymentDialog({
  projectId,
  deploymentShortCode,
  redirectPath,
}: RollbackDeploymentDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/${projectId}/deployments/${deploymentShortCode}/rollback`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="rollback">
      <DialogHeader>Rollback to this deployment?</DialogHeader>
      <DialogDescription>
        This deployment will become the default for all future runs. Tasks triggered but not
        included in this deploy will remain queued until you roll back to or create a new deployment
        with these tasks included.
      </DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <Form
          action={`/resources/${projectId}/deployments/${deploymentShortCode}/rollback`}
          method="post"
        >
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="primary/medium"
            LeadingIcon={isLoading ? SpinnerWhite : ArrowPathIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {isLoading ? "Rolling back..." : "Rollback deployment"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

function PromoteDeploymentDialog({
  projectId,
  deploymentShortCode,
  redirectPath,
}: RollbackDeploymentDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/${projectId}/deployments/${deploymentShortCode}/promote`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="promote">
      <DialogHeader>Promote this deployment?</DialogHeader>
      <DialogDescription>
        This deployment will become the default for all future runs not explicitly tied to a
        specific deployment.
      </DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <Form
          action={`/resources/${projectId}/deployments/${deploymentShortCode}/promote`}
          method="post"
        >
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="primary/medium"
            LeadingIcon={isLoading ? SpinnerWhite : ArrowPathIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {isLoading ? "Promoting..." : "Promote deployment"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelDeploymentDialog({
  projectId,
  deploymentShortCode,
  redirectPath,
}: RollbackDeploymentDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/${projectId}/deployments/${deploymentShortCode}/cancel`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="cancel">
      <DialogHeader>Cancel this deployment?</DialogHeader>
      <DialogDescription>Canceling a deployment cannot be undone. Are you sure?</DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Back</Button>
        </DialogClose>
        <Form action={formAction} method="post">
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="danger/medium"
            LeadingIcon={isLoading ? SpinnerWhite : NoSymbolIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {isLoading ? "Canceling..." : "Cancel deployment"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}
