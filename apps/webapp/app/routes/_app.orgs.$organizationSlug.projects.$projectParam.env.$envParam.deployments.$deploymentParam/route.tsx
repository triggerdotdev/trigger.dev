import { Link, useLocation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
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
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3DeploymentParams, v3DeploymentsPath, v3RunsPath } from "~/utils/pathBuilder";
import { capitalizeWord } from "~/utils/string";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, deploymentParam } =
    v3DeploymentParams.parse(params);

  try {
    const presenter = new DeploymentPresenter();
    const { deployment } = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      environmentSlug: envParam,
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
  const { deployment } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const user = useUser();
  const page = new URLSearchParams(location.search).get("page");

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
          to={`${v3DeploymentsPath(organization, project, environment)}${
            page ? `?page=${page}` : ""
          }`}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col">
          <div className="p-3">
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
                  <EnvironmentCombo environment={deployment.environment} />
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
                <Property.Value>
                  {deployment.sdkVersion ? deployment.sdkVersion : "–"}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>CLI Version</Property.Label>
                <Property.Value>
                  {deployment.cliVersion ? deployment.cliVersion : "–"}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Worker type</Property.Label>
                <Property.Value>{capitalizeWord(deployment.type)}</Property.Value>
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
          </div>

          {deployment.tasks ? (
            <div className="divide-y divide-charcoal-800 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
              <Table variant="bright">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className="px-2">Task</TableHeaderCell>
                    <TableHeaderCell className="px-2">File path</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deployment.tasks.map((t) => {
                    const path = v3RunsPath(organization, project, environment, {
                      tasks: [t.slug],
                    });
                    return (
                      <TableRow key={t.slug}>
                        <TableCell to={path}>
                          <div className="inline-flex flex-col gap-0.5">
                            <Paragraph variant="extra-small" className="text-text-dimmed">
                              {t.slug}
                            </Paragraph>
                          </div>
                        </TableCell>
                        <TableCell to={path}>{t.filePath}</TableCell>
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
