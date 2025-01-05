import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  BookOpenIcon,
  ServerStackIcon,
} from "@heroicons/react/20/solid";
import { MetaFunction, Outlet, useLocation, useParams } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { InfoPanel } from "~/components/primitives/InfoPanel";
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
import { TextLink } from "~/components/primitives/TextLink";
import {
  DeploymentStatus,
  deploymentStatusDescription,
  deploymentStatuses,
} from "~/components/runs/v3/DeploymentStatus";
import { RetryDeploymentIndexingDialog } from "~/components/runs/v3/RetryDeploymentIndexingDialog";
import { RollbackDeploymentDialog } from "~/components/runs/v3/RollbackDeploymentDialog";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import {
  DeploymentListItem,
  DeploymentListPresenter,
} from "~/presenters/v3/DeploymentListPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  ProjectParamSchema,
  docsPath,
  v3DeploymentPath,
  v3EnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { createSearchParams } from "~/utils/searchParams";
import { deploymentIndexingIsRetryable } from "~/v3/deploymentStatus";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Deployments | Trigger.dev`,
    },
  ];
};

const SearchParams = z.object({
  page: z.coerce.number().optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const searchParams = createSearchParams(request.url, SearchParams);
  const page = searchParams.success ? searchParams.params.get("page") ?? 1 : 1;

  try {
    const presenter = new DeploymentListPresenter();
    const result = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      page,
    });

    return typedjson(result);
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
  const user = useUser();
  const { deployments, currentPage, totalPages } = useTypedLoaderData<typeof loader>();
  const hasDeployments = totalPages > 0;

  const { deploymentParam } = useParams();

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
                      <TableHeaderCell>Env</TableHeaderCell>
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
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deployments.length > 0 ? (
                      deployments.map((deployment) => {
                        const usernameForEnv =
                          user.id !== deployment.environment.userId
                            ? deployment.environment.userName
                            : undefined;
                        const path = v3DeploymentPath(
                          organization,
                          project,
                          deployment,
                          currentPage
                        );
                        const isSelected = deploymentParam === deployment.shortCode;
                        return (
                          <TableRow key={deployment.id} className="group" isSelected={isSelected}>
                            <TableCell to={path} isSelected={isSelected}>
                              <div className="flex items-center gap-2">
                                <Paragraph variant="extra-small">{deployment.shortCode}</Paragraph>
                                {deployment.label && (
                                  <Badge variant="outline-rounded">{deployment.label}</Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell to={path} isSelected={isSelected}>
                              <EnvironmentLabel
                                environment={deployment.environment}
                                userName={usernameForEnv}
                              />
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
                            <DeploymentActionsCell
                              deployment={deployment}
                              path={path}
                              isSelected={isSelected}
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
                {totalPages > 1 && (
                  <div className="-mt-px flex justify-end border-t border-grid-dimmed py-2 pr-2">
                    <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                  </div>
                )}
              </div>
            ) : (
              <CreateDeploymentInstructions />
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

function CreateDeploymentInstructions() {
  const organization = useOrganization();
  const project = useProject();

  return (
    <MainCenteredContainer className="max-w-md">
      <InfoPanel
        icon={ServerStackIcon}
        iconClassName="text-blue-500"
        title="Deploy for the first time"
        panelClassName="max-w-full"
      >
        <Paragraph spacing variant="small">
          There are several ways to deploy your tasks. You can use the CLI, Continuous Integration
          (like GitHub Actions), or an integration with a service like Netlify or Vercel. Make sure
          you{" "}
          <TextLink href={v3EnvironmentVariablesPath(organization, project)}>
            set your environment variables
          </TextLink>{" "}
          first.
        </Paragraph>
        <div className="flex gap-3">
          <LinkButton
            to={docsPath("v3/cli-deploy")}
            variant="docs/medium"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            Deploy with the CLI
          </LinkButton>
          <LinkButton
            to={docsPath("v3/github-actions")}
            variant="docs/medium"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            Deploy with GitHub actions
          </LinkButton>
        </div>
      </InfoPanel>
    </MainCenteredContainer>
  );
}

function DeploymentActionsCell({
  deployment,
  path,
  isSelected,
}: {
  deployment: DeploymentListItem;
  path: string;
  isSelected: boolean;
}) {
  const location = useLocation();
  const project = useProject();

  const canRollback = !deployment.isCurrent && deployment.isDeployed;
  const canRetryIndexing = deployment.isLatest && deploymentIndexingIsRetryable(deployment);

  if (!canRollback && !canRetryIndexing) {
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
          {canRollback && (
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
