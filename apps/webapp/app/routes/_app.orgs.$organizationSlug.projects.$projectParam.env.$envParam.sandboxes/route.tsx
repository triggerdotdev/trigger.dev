import { BookOpenIcon } from "@heroicons/react/20/solid";
import { type MetaFunction, Outlet, useParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import {
  SandboxStatus,
  sandboxStatusDescription,
  sandboxStatuses,
} from "~/components/runs/v3/SandboxStatus";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { SandboxListPresenter } from "~/presenters/v3/SandboxListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, docsPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Sandboxes | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const presenter = new SandboxListPresenter($replica);

  try {
    const result = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      environmentSlug: envParam,
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
  const environment = useEnvironment();
  const { sandboxes } = useTypedLoaderData<typeof loader>();
  const hasSandboxes = sandboxes.length > 0;

  const { sandboxParam } = useParams();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Sandboxes" />
        <PageAccessories>
          <LinkButton variant={"docs/small"} LeadingIcon={BookOpenIcon} to={docsPath("/sandboxes")}>
            Sandboxes docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="h-full max-h-full">
          <ResizablePanel id="sandboxes-main" min="100px" className="max-h-full">
            {hasSandboxes ? (
              <div className="flex h-full max-h-full flex-col">
                <Table containerClassName="border-t-0 grow">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>ID</TableHeaderCell>
                      <TableHeaderCell>Task</TableHeaderCell>
                      <TableHeaderCell
                        tooltip={
                          <div className="flex flex-col divide-y divide-grid-dimmed">
                            {sandboxStatuses.map((status) => (
                              <div
                                key={status}
                                className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1"
                              >
                                <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                                  <SandboxStatus status={status} />
                                </div>
                                <Paragraph
                                  variant="extra-small"
                                  className="!text-wrap text-text-dimmed"
                                >
                                  {sandboxStatusDescription(status)}
                                </Paragraph>
                              </div>
                            ))}
                          </div>
                        }
                      >
                        Status
                      </TableHeaderCell>
                      <TableHeaderCell>Runtime</TableHeaderCell>
                      <TableHeaderCell>Packages</TableHeaderCell>
                      <TableHeaderCell>System Packages</TableHeaderCell>
                      <TableHeaderCell>Created</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sandboxes.map((sandbox) => {
                      const isSelected = sandboxParam === sandbox.friendlyId;
                      return (
                        <TableRow key={sandbox.id} className="group" isSelected={isSelected}>
                          <TableCell isTabbableCell isSelected={isSelected}>
                            <TruncatedCopyableValue value={sandbox.friendlyId} />
                          </TableCell>
                          <TableCell isSelected={isSelected}>
                            {sandbox.tasks.length === 1 ? (
                              <SimpleTooltip
                                content={sandbox.tasks[0].filePath}
                                button={
                                  <Paragraph variant="extra-small" className="font-mono">
                                    {sandbox.tasks[0].slug}
                                  </Paragraph>
                                }
                                disableHoverableContent
                              />
                            ) : (
                              <SimpleTooltip
                                content={
                                  <div className="flex flex-col gap-1">
                                    {sandbox.tasks.map((task) => (
                                      <div key={task.slug} className="flex flex-col">
                                        <span className="font-mono text-xs">{task.slug}</span>
                                        <span className="text-xs text-text-dimmed">
                                          {task.filePath}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                }
                                button={
                                  <Paragraph variant="extra-small">
                                    {sandbox.taskCount} tasks
                                  </Paragraph>
                                }
                              />
                            )}
                          </TableCell>
                          <TableCell isSelected={isSelected}>
                            <SandboxStatus status={sandbox.status} />
                          </TableCell>
                          <TableCell isSelected={isSelected}>
                            <SandboxRuntime runtime={sandbox.runtime} />
                          </TableCell>
                          <TableCell isSelected={isSelected}>
                            <PackagesList packages={sandbox.packages} />
                          </TableCell>
                          <TableCell isSelected={isSelected}>
                            <PackagesList packages={sandbox.systemPackages} />
                          </TableCell>
                          <TableCell isSelected={isSelected}>
                            <DateTime date={sandbox.createdAt} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <MainCenteredContainer className="max-w-md">
                <Paragraph className="text-center text-text-dimmed">
                  No sandboxes found for this environment.
                </Paragraph>
              </MainCenteredContainer>
            )}
          </ResizablePanel>

          {sandboxParam && (
            <>
              <ResizableHandle id="sandboxes-handle" />
              <ResizablePanel id="sandboxes-inspector" min="400px" max="700px">
                <Outlet />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

function SandboxRuntime({ runtime }: { runtime: string }) {
  // Parse runtime string in format "node:22" or "bun:1.3.0"
  const parts = runtime.split(":");
  const runtimeName = parts[0];
  const runtimeVersion = parts[1];

  return <RuntimeIcon runtime={runtimeName} runtimeVersion={runtimeVersion} withLabel />;
}

function PackagesList({ packages }: { packages: string[] }) {
  if (packages.length === 0) {
    return <Paragraph variant="extra-small">–</Paragraph>;
  }

  // Show up to 2 packages inline
  if (packages.length <= 2) {
    return (
      <Paragraph variant="extra-small" className="font-mono">
        {packages.join(", ")}
      </Paragraph>
    );
  }

  // Show first 2 packages and "X more" with tooltip
  const displayPackages = packages.slice(0, 2);
  const remainingCount = packages.length - 2;

  return (
    <SimpleTooltip
      content={
        <div className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
          {packages.map((pkg) => (
            <div key={pkg} className="font-mono text-xs">
              {pkg}
            </div>
          ))}
        </div>
      }
      button={
        <Paragraph variant="extra-small" className="font-mono">
          {displayPackages.join(", ")}
          <span className="font-sans text-text-dimmed">, and {remainingCount} more</span>
        </Paragraph>
      }
    />
  );
}
