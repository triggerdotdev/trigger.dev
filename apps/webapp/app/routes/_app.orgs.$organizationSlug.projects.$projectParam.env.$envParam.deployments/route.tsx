import { ArrowPathIcon, ArrowUturnLeftIcon, BookOpenIcon } from "@heroicons/react/20/solid";
import { type MetaFunction, Outlet, useLocation, useParams, useNavigate } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PromoteIcon } from "~/assets/icons/PromoteIcon";
import { DeploymentsNone, DeploymentsNoneDev } from "~/components/BlankStatePanels";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
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
import { RetryDeploymentIndexingDialog } from "~/components/runs/v3/RetryDeploymentIndexingDialog";
import {
  PromoteDeploymentDialog,
  RollbackDeploymentDialog,
} from "~/components/runs/v3/RollbackDeploymentDialog";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  type DeploymentListItem,
  DeploymentListPresenter,
} from "~/presenters/v3/DeploymentListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { titleCase } from "~/utils";
import { EnvironmentParamSchema, docsPath, v3DeploymentPath } from "~/utils/pathBuilder";
import { createSearchParams } from "~/utils/searchParams";
import { deploymentIndexingIsRetryable } from "~/v3/deploymentStatus";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";
import { useEffect } from "react";
import { GitMetadata } from "~/components/GitMetadata";

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

    return typedjson({ ...result, selectedDeployment });
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
  const { deployments, currentPage, totalPages, selectedDeployment } =
    useTypedLoaderData<typeof loader>();
  const hasDeployments = totalPages > 0;

  const { deploymentParam } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

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
              <div className="grid max-h-full grid-rows-[1fr_auto]">
                <Table containerClassName="border-t-0">
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
                              {deployment.deployedBy ? (
                                <div className="flex items-center gap-1">
                                  <UserAvatar
                                    avatarUrl={deployment.deployedBy.avatarUrl}
                                    name={
                                      deployment.deployedBy.name ??
                                      deployment.deployedBy.displayName
                                    }
                                    className="h-4 w-4"
                                  />
                                  <Paragraph variant="extra-small">
                                    {deployment.deployedBy.name ??
                                      deployment.deployedBy.displayName}
                                  </Paragraph>
                                </div>
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
                      <TableBlankRow colSpan={7}>
                        <Paragraph className="flex items-center justify-center">
                          No deploys match your filters
                        </Paragraph>
                      </TableBlankRow>
                    )}
                  </TableBody>
                </Table>
                {totalPages > 1 && (
                  <div className="-mt-px flex justify-end border-t border-grid-dimmed py-2 pr-2">
                    <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                  </div>
                )}
              </div>
            ) : environment.type === "DEVELOPMENT" ? (
              <MainCenteredContainer className="max-w-md">
                <DeploymentsNoneDev />
              </MainCenteredContainer>
            ) : (
              <MainCenteredContainer className="max-w-md">
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
  const canRetryIndexing = deployment.isLatest && deploymentIndexingIsRetryable(deployment);
  const canBeRolledBack =
    canBeMadeCurrent &&
    currentDeployment?.version &&
    compareDeploymentVersions(deployment.version, currentDeployment.version) === -1;
  const canBePromoted = canBeMadeCurrent && !canBeRolledBack;

  if (!canBeMadeCurrent && !canRetryIndexing) {
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
                  Rollback…
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
                  Promote…
                </Button>
              </DialogTrigger>
              <PromoteDeploymentDialog
                projectId={project.id}
                deploymentShortCode={deployment.shortCode}
                redirectPath={`${location.pathname}${location.search}`}
              />
            </Dialog>
          )}
          {canRetryIndexing && (
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="small-menu-item"
                  LeadingIcon={ArrowPathIcon}
                  leadingIconClassName="text-blue-500"
                  fullWidth
                  textAlignLeft
                >
                  Retry indexing…
                </Button>
              </DialogTrigger>
              <RetryDeploymentIndexingDialog
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
