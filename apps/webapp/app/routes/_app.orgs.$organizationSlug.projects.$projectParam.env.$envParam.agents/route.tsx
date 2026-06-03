import { BeakerIcon, CpuChipIcon, MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/node";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
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
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { TaskFileName } from "~/components/runs/v3/TaskPath";
import { useFuzzyFilter } from "~/hooks/useFuzzyFilter";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type AgentListItem,
  type AgentActiveState,
  agentListPresenter,
} from "~/presenters/v3/AgentListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3RunsPath, v3PlaygroundAgentPath } from "~/utils/pathBuilder";
import { cn } from "~/utils/cn";

export const meta: MetaFunction = () => {
  return [{ title: "Agents | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const result = await agentListPresenter.call({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    environmentType: environment.type,
  });

  return typeddefer(result);
};

export default function AgentsPage() {
  const { agents, activeStates, conversationSparklines, costSparklines, tokenSparklines } =
    useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const { filterText, setFilterText, filteredItems } = useFuzzyFilter({
    items: agents,
    keys: ["slug", "filePath"],
  });

  if (agents.length === 0) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Agents" />
        </NavBar>
        <PageBody>
          <MainCenteredContainer>
            <div className="flex flex-col items-center gap-4 py-20">
              <CpuChipIcon className="size-12 text-indigo-500" />
              <Header2>No agents deployed</Header2>
              <Paragraph variant="small" className="max-w-md text-center">
                Create a chat agent using <code>chat.agent()</code> from{" "}
                <code>@trigger.dev/sdk/ai</code> and deploy it to see it here.
              </Paragraph>
            </div>
          </MainCenteredContainer>
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Agents" />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid h-full grid-rows-1">
          <div className="flex min-w-0 max-w-full flex-col">
            <div className="max-h-full overflow-hidden">
              <div className="flex items-center gap-1 p-2">
                <Input
                  placeholder="Search agents"
                  variant="tertiary"
                  icon={MagnifyingGlassIcon}
                  fullWidth={true}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  autoFocus
                />
              </div>
              <Table containerClassName="max-h-full pb-[2.5rem]">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>ID</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>File</TableHeaderCell>
                    <TableHeaderCell>Active</TableHeaderCell>
                    <TableHeaderCell>Conversations (24h)</TableHeaderCell>
                    <TableHeaderCell>Cost (24h)</TableHeaderCell>
                    <TableHeaderCell>Tokens (24h)</TableHeaderCell>
                    <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.length > 0 ? (
                    filteredItems.map((agent) => {
                      const path = v3RunsPath(organization, project, environment, {
                        tasks: [agent.slug],
                      });
                      const agentType =
                        (agent.config as { type?: string } | null)?.type ?? "unknown";

                      return (
                        <TableRow key={agent.slug} className="group">
                          <TableCell to={path} isTabbableCell>
                            <div className="flex items-center gap-2">
                              <SimpleTooltip
                                button={
                                  <CpuChipIcon className="size-[1.125rem] min-w-[1.125rem] text-indigo-500" />
                                }
                                content="Agent"
                              />
                              <span>{agent.slug}</span>
                            </div>
                          </TableCell>
                          <TableCell to={path}>
                            <Badge variant="extra-small">{formatAgentType(agentType)}</Badge>
                          </TableCell>
                          <TableCell to={path}>
                            <TaskFileName fileName={agent.filePath} variant="extra-extra-small" />
                          </TableCell>
                          <TableCell to={path}>
                            <Suspense fallback={<Spinner color="muted" />}>
                              <TypedAwait resolve={activeStates} errorElement={<>–</>}>
                                {(data) => {
                                  const state = data[agent.slug];
                                  if (!state || (state.running === 0 && state.suspended === 0)) {
                                    return (
                                      <span className="text-text-dimmed">–</span>
                                    );
                                  }
                                  return (
                                    <span className="flex items-center gap-1.5 text-xs">
                                      {state.running > 0 && (
                                        <span className="flex items-center gap-0.5">
                                          <span className="size-1.5 rounded-full bg-success" />
                                          <span>{state.running}</span>
                                        </span>
                                      )}
                                      {state.running > 0 && state.suspended > 0 && (
                                        <span className="text-text-dimmed">·</span>
                                      )}
                                      {state.suspended > 0 && (
                                        <span className="flex items-center gap-0.5">
                                          <span className="size-1.5 rounded-full bg-blue-500" />
                                          <span>{state.suspended}</span>
                                        </span>
                                      )}
                                    </span>
                                  );
                                }}
                              </TypedAwait>
                            </Suspense>
                          </TableCell>
                          <TableCell to={path} actionClassName="py-1.5">
                            <Suspense fallback={<SparklinePlaceholder />}>
                              <TypedAwait resolve={conversationSparklines} errorElement={<>–</>}>
                                {(data) => (
                                  <SparklineWithTotal
                                    data={data[agent.slug]}
                                    formatTotal={formatCount}
                                  />
                                )}
                              </TypedAwait>
                            </Suspense>
                          </TableCell>
                          <TableCell to={path} actionClassName="py-1.5">
                            <Suspense fallback={<SparklinePlaceholder />}>
                              <TypedAwait resolve={costSparklines} errorElement={<>–</>}>
                                {(data) => (
                                  <SparklineWithTotal
                                    data={data[agent.slug]}
                                    formatTotal={formatCost}
                                    color="text-amber-400"
                                    barColor="#F59E0B"
                                  />
                                )}
                              </TypedAwait>
                            </Suspense>
                          </TableCell>
                          <TableCell to={path} actionClassName="py-1.5">
                            <Suspense fallback={<SparklinePlaceholder />}>
                              <TypedAwait resolve={tokenSparklines} errorElement={<>–</>}>
                                {(data) => (
                                  <SparklineWithTotal
                                    data={data[agent.slug]}
                                    formatTotal={formatTokens}
                                    color="text-purple-400"
                                    barColor="#A855F7"
                                  />
                                )}
                              </TypedAwait>
                            </Suspense>
                          </TableCell>
                          <TableCellMenu
                            isSticky
                            popoverContent={
                              <>
                                <PopoverMenuItem
                                  icon={RunsIcon}
                                  to={path}
                                  title="View runs"
                                  leadingIconClassName="text-runs"
                                />
                                <PopoverMenuItem
                                  icon={BeakerIcon}
                                  to={v3PlaygroundAgentPath(organization, project, environment, agent.slug)}
                                  title="Playground"
                                  leadingIconClassName="text-indigo-400"
                                />
                              </>
                            }
                            hiddenButtons={
                              <LinkButton
                                variant="minimal/small"
                                LeadingIcon={BeakerIcon}
                                leadingIconClassName="text-text-bright"
                                to={v3PlaygroundAgentPath(organization, project, environment, agent.slug)}
                              >
                                Playground
                              </LinkButton>
                            }
                          />
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableBlankRow colSpan={8}>
                      <Paragraph variant="small" className="flex items-center justify-center">
                        No agents match your filters
                      </Paragraph>
                    </TableBlankRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function formatAgentType(type: string): string {
  switch (type) {
    case "ai-sdk-chat":
      return "AI SDK Chat";
    default:
      return type;
  }
}

function formatCount(total: number): string {
  if (total === 0) return "0";
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
  return total.toString();
}

function formatCost(total: number): string {
  if (total === 0) return "$0";
  if (total < 0.01) return `$${total.toFixed(4)}`;
  if (total < 1) return `$${total.toFixed(2)}`;
  return `$${total.toFixed(2)}`;
}

function formatTokens(total: number): string {
  if (total === 0) return "0";
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
  return total.toString();
}

function SparklinePlaceholder() {
  return <div className="h-6 w-24" />;
}

function SparklineWithTotal({
  data,
  formatTotal,
  color = "text-text-bright",
  barColor = "#3B82F6",
}: {
  data?: number[];
  formatTotal: (total: number) => string;
  color?: string;
  barColor?: string;
}) {
  if (!data || data.every((v) => v === 0)) {
    return <span className="text-text-dimmed">–</span>;
  }

  const total = data.reduce((sum, v) => sum + v, 0);
  const max = Math.max(...data);

  return (
    <div className="flex items-center gap-2">
      <div className="flex h-5 items-end gap-px">
        {data.map((value, i) => {
          const height = max > 0 ? Math.max((value / max) * 100, value > 0 ? 8 : 0) : 0;
          return (
            <div
              key={i}
              className="w-[3px] rounded-t-[1px]"
              style={{
                height: `${height}%`,
                backgroundColor: value > 0 ? barColor : "transparent",
                opacity: value > 0 ? 0.8 : 0,
              }}
            />
          );
        })}
      </div>
      <span className={cn("text-xs tabular-nums", color)}>{formatTotal(total)}</span>
    </div>
  );
}
