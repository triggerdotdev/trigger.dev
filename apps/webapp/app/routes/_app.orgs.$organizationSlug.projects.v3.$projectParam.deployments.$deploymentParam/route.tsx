import { Link, useLocation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { DeploymentError } from "~/components/runs/v3/DeploymentError";
import { DeploymentStatus } from "~/components/runs/v3/DeploymentStatus";
import { TaskFunctionName } from "~/components/runs/v3/TaskPath";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3DeploymentParams, v3DeploymentsPath } from "~/utils/pathBuilder";

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

        <AdminDebugTooltip>
          <Property.Table>
            <Property.Item>
              <Property.Label>ID</Property.Label>
              <Property.Value>{deployment.id}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Project ID</Property.Label>
              <Property.Value>{deployment.projectId}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Org ID</Property.Label>
              <Property.Value>{deployment.organizationId}</Property.Value>
            </Property.Item>
            {deployment.imageReference && (
              <Property.Item>
                <Property.Label>Image</Property.Label>
                <Property.Value>{deployment.imageReference}</Property.Value>
              </Property.Item>
            )}
            {deployment.externalBuildData && (
              <Property.Item>
                <Property.Label>Build Server</Property.Label>
                <Property.Value>
                  <Link
                    to={`/resources/${deployment.projectId}/deployments/${deployment.id}/logs`}
                    className="extra-small/bright/mono underline"
                  >
                    {deployment.externalBuildData.buildId}
                  </Link>
                </Property.Value>
              </Property.Item>
            )}
          </Property.Table>
        </AdminDebugTooltip>

        <LinkButton
          to={`${v3DeploymentsPath(organization, project)}${page ? `?page=${page}` : ""}`}
          variant="minimal/medium"
          LeadingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
        />
      </div>
      <div className="overflow-y-auto px-3 pt-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col gap-4">
          <Property.Table>
            <Property.Item>
              <Property.Label>Deploy</Property.Label>
              <Property.Value className="flex items-center gap-2">
                <span>{deployment.shortCode}</span>
                {deployment.label && <Badge variant="outline-rounded">{deployment.label}</Badge>}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Environment</Property.Label>
              <Property.Value>
                <EnvironmentLabel environment={deployment.environment} userName={usernameForEnv} />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Version</Property.Label>
              <Property.Value>{deployment.version}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Status</Property.Label>
              <Property.Value>
                <DeploymentStatus
                  status={deployment.status}
                  isBuilt={deployment.isBuilt}
                  className="text-sm"
                />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Tasks</Property.Label>
              <Property.Value>{deployment.tasks ? deployment.tasks.length : "–"}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>SDK Version</Property.Label>
              <Property.Value>{deployment.sdkVersion ? deployment.sdkVersion : "–"}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>CLI Version</Property.Label>
              <Property.Value>{deployment.cliVersion ? deployment.cliVersion : "–"}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Started at</Property.Label>
              <Property.Value>
                <DateTimeAccurate date={deployment.createdAt} /> UTC
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Built at</Property.Label>
              <Property.Value>
                {deployment.builtAt ? (
                  <>
                    <DateTimeAccurate date={deployment.builtAt} /> UTC
                  </>
                ) : (
                  "–"
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Deployed at</Property.Label>
              <Property.Value>
                {deployment.deployedAt ? (
                  <>
                    <DateTimeAccurate date={deployment.deployedAt} /> UTC
                  </>
                ) : (
                  "–"
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Deployed by</Property.Label>
              <Property.Value>
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
              </Property.Value>
            </Property.Item>
          </Property.Table>

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
          ) : deployment.errorData ? (
            <DeploymentError errorData={deployment.errorData} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
