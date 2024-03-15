import { CommandLineIcon, ServerIcon } from "@heroicons/react/20/solid";
import { useLocation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TerminalIcon, TerminalSquareIcon } from "lucide-react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { BlankstateInstructions } from "~/components/BlankstateInstructions";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import { ResizablePanel, ResizablePanelGroup } from "~/components/primitives/Resizable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { DeploymentStatus } from "~/components/runs/v3/DeploymentStatus";
import { TaskFunctionName } from "~/components/runs/v3/TaskPath";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { DeploymentListPresenter } from "~/presenters/v3/DeploymentListPresenter.server";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  ProjectParamSchema,
  docsPath,
  runParam,
  v3DeploymentParams,
  v3DeploymentPath,
  v3DeploymentsPath,
  v3RunPath,
} from "~/utils/pathBuilder";
import { createSearchParams } from "~/utils/searchParams";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, deploymentParam } = v3DeploymentParams.parse(params);

  try {
    const presenter = new DeploymentPresenter();
    const { deployment } = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      deploymentShortCode: deploymentParam,
    });

    return typedjson({ deployment });
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
  const location = useLocation();
  const user = useUser();
  const { deployment } = useTypedLoaderData<typeof loader>();
  const page = new URLSearchParams(location.search).get("page");

  const usernameForEnv =
    user.id !== deployment.environment.userId ? deployment.environment.userName : undefined;

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>Deploy: {deployment.shortCode}</Header2>
        <LinkButton
          to={`${v3DeploymentsPath(organization, project)}${page ? `?page=${page}` : ""}`}
          variant="minimal/medium"
          LeadingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
        />
      </div>
      <div className="overflow-y-auto px-3 pt-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col gap-4">
          <PropertyTable>
            <Property label="Deploy">
              <div className="flex items-center gap-2">
                <Paragraph variant="small/bright">{deployment.shortCode}</Paragraph>
                {deployment.label && <Badge variant="outline-rounded">{deployment.label}</Badge>}
              </div>
            </Property>
            <Property label="Environment">
              <EnvironmentLabel environment={deployment.environment} userName={usernameForEnv} />
            </Property>
            <Property label="Version">{deployment.version}</Property>
            <Property label="Status">
              <DeploymentStatus status={deployment.status} className="text-sm" />
            </Property>
            <Property label="Tasks">{deployment.tasks ? deployment.tasks.length : "–"}</Property>
            <Property label="Deployed at">
              <Paragraph variant="small/bright">
                {deployment.deployedAt ? (
                  <>
                    <DateTimeAccurate date={deployment.deployedAt} /> UTC
                  </>
                ) : (
                  "–"
                )}
              </Paragraph>
            </Property>
            <Property label="Deployed by">
              {deployment.deployedBy ? (
                <div className="flex items-center gap-1">
                  <UserAvatar
                    avatarUrl={deployment.deployedBy.avatarUrl}
                    name={deployment.deployedBy.name ?? deployment.deployedBy.displayName}
                    className="h-4 w-4"
                  />
                  <Paragraph variant="small">
                    {deployment.deployedBy.name ?? deployment.deployedBy.displayName}
                  </Paragraph>
                </div>
              ) : (
                "–"
              )}
            </Property>
          </PropertyTable>

          {deployment.tasks ? (
            <div className="divide-y divide-charcoal-800 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className="px-2">Task</TableHeaderCell>
                    <TableHeaderCell className="px-2">File path</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deployment.tasks.map((t) => {
                    return (
                      <TableRow key={t.slug}>
                        <TableCell>
                          <div className="inline-flex flex-col gap-0.5">
                            <TaskFunctionName
                              variant="extra-small"
                              functionName={t.exportName}
                              className="-ml-1 inline-flex"
                            />
                            <Paragraph variant="extra-small" className="text-text-dimmed">
                              {t.slug}
                            </Paragraph>
                          </div>
                        </TableCell>
                        <TableCell>{t.filePath}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
