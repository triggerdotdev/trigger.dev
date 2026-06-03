import { CpuChipIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/node";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense } from "react";
import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
  type TooltipProps,
} from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SearchInput } from "~/components/primitives/SearchInput";
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
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { TaskFileName } from "~/components/runs/v3/TaskPath";
import { useFuzzyFilter } from "~/hooks/useFuzzyFilter";
import { useSearchParams } from "~/hooks/useSearchParam";
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
import {
  EnvironmentParamSchema,
  v3AgentTaskPath,
  v3RunsPath,
  v3PlaygroundAgentPath,
  v3ModelsPath,
} from "~/utils/pathBuilder";
import { cn } from "~/utils/cn";
import { Box3DIcon } from "~/assets/icons/Box3DIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";

export const meta: MetaFunction = () => {
  return [{ title: "Agent tasks | Trigger.dev" }];
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

  const { value } = useSearchParams();
  const searchText = value("search") ?? "";

  const { filteredItems } = useFuzzyFilter({
    items: agents,
    keys: ["slug", "filePath"],
    filterText: searchText,
  });

  if (agents.length === 0) {
    return (
      <>
        <NavBar>
          <PageTitle title="Agent tasks" />
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
      </>
    );
  }

  return (
    <>
      <NavBar>
        <PageTitle title="Agent tasks" />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid h-full grid-rows-1">
          <div className="flex min-w-0 max-w-full flex-col">
            <div className="max-h-full overflow-hidden">
              <div className="flex items-center gap-1.5 border-b border-grid-bright p-2">
                <SearchInput placeholder="Search agents…" autoFocus />
              </div>
              <Table containerClassName="max-h-full pb-[2.5rem]" showTopBorder={false}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Agent ID</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>File</TableHeaderCell>
                    <TableHeaderCell
                      tooltip={
                        <div className="flex max-w-[18rem] flex-col gap-3 p-1 pb-2">
                          <div>
                            <Header3>Active runs</Header3>
                            <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                              Live count of in-flight runs for this agent.
                            </Paragraph>
                          </div>
                          <div className="flex flex-col gap-2">
                            <div>
                              <div className="mb-0.5 flex items-center gap-2">
                                <span className="size-1.5 shrink-0 rounded-full bg-success" />
                                <Paragraph variant="small" className="!text-wrap text-text-bright">
                                  Running
                                </Paragraph>
                              </div>
                              <Paragraph
                                variant="small"
                                className="!text-wrap pl-3.5 text-text-dimmed"
                              >
                                Runs currently executing.
                              </Paragraph>
                            </div>
                            <div>
                              <div className="mb-0.5 flex items-center gap-2">
                                <span className="size-1.5 shrink-0 rounded-full bg-blue-500" />
                                <Paragraph variant="small" className="!text-wrap text-text-bright">
                                  Suspended
                                </Paragraph>
                              </div>
                              <Paragraph
                                variant="small"
                                className="!text-wrap pl-3.5 text-text-dimmed"
                              >
                                Runs paused while waiting (e.g. on a tool, user input, or another
                                task).
                              </Paragraph>
                            </div>
                          </div>
                        </div>
                      }
                      disableTooltipHoverableContent
                    >
                      Active
                    </TableHeaderCell>
                    <TableHeaderCell>Sessions (24h)</TableHeaderCell>
                    <TableHeaderCell
                      tooltip={
                        <div className="flex max-w-[12rem] flex-col gap-3 p-1 pb-2">
                          <div>
                            <Header3>LLM spend (last 24h)</Header3>
                            <Paragraph
                              variant="small"
                              className="!text-wrap text-text-dimmed"
                              spacing
                            >
                              The estimated amount you'd pay model providers for tokens used in the
                              last 24 hours.
                            </Paragraph>
                            <LinkButton
                              to={v3ModelsPath(organization, project, environment)}
                              variant="secondary/small"
                              LeadingIcon={Box3DIcon}
                              leadingIconClassName="-mx-2"
                            >
                              View models catalog
                            </LinkButton>
                          </div>
                        </div>
                      }
                    >
                      LLM spend (24h)
                    </TableHeaderCell>
                    <TableHeaderCell>Tokens (24h)</TableHeaderCell>
                    <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.length > 0 ? (
                    filteredItems.map((agent) => {
                      const path = v3AgentTaskPath(
                        organization,
                        project,
                        environment,
                        agent.slug
                      );
                      const runsPath = v3RunsPath(organization, project, environment, {
                        tasks: [agent.slug],
                      });
                      const agentType =
                        (agent.config as { type?: string } | null)?.type ?? "unknown";

                      return (
                        <TableRow key={agent.slug} className="group">
                          <TableCell to={path} isTabbableCell>
                            <div className="flex items-center gap-2">
                              <SimpleTooltip
                                button={<CubeSparkleIcon className="size-4.5 text-agents" />}
                                content="Agent"
                                disableHoverableContent
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
                                    return <span className="text-text-dimmed">–</span>;
                                  }
                                  return (
                                    <span className="flex items-center gap-1.5 text-xs">
                                      {state.running > 0 && (
                                        <span className="flex items-center gap-1.5">
                                          <span className="size-1.5 rounded-full bg-success" />
                                          <span>{state.running}</span>
                                        </span>
                                      )}
                                      {state.running > 0 && state.suspended > 0 && (
                                        <span className="text-text-dimmed">·</span>
                                      )}
                                      {state.suspended > 0 && (
                                        <span className="flex items-center gap-1.5">
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
                                    color="text-blue-400"
                                    tooltipLabel={(v) =>
                                      v === 1 ? "conversation" : "conversations"
                                    }
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
                                    formatTooltipValue={formatCost}
                                    tooltipLabel={() => "spend"}
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
                                    formatTooltipValue={formatTokens}
                                    tooltipLabel={(v) => (v === 1 ? "token" : "tokens")}
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
                                  to={runsPath}
                                  title="View runs"
                                  leadingIconClassName="text-runs"
                                />
                                <PopoverMenuItem
                                  icon={BeakerIcon}
                                  to={v3PlaygroundAgentPath(
                                    organization,
                                    project,
                                    environment,
                                    agent.slug
                                  )}
                                  title="Test"
                                  leadingIconClassName="text-tests"
                                />
                              </>
                            }
                            hiddenButtons={
                              <LinkButton
                                variant="minimal/small"
                                LeadingIcon={BeakerIcon}
                                leadingIconClassName="-mx-2.5 text-text-bright"
                                to={v3PlaygroundAgentPath(
                                  organization,
                                  project,
                                  environment,
                                  agent.slug
                                )}
                              >
                                Test
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
    </>
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
  return <div className="h-6 w-[7rem]" />;
}

type SparklineDatum = { date: Date; count: number };

function SparklineWithTotal({
  data,
  formatTotal,
  color = "text-text-bright",
  barColor = "#3B82F6",
  tooltipLabel,
  formatTooltipValue,
}: {
  data?: number[];
  formatTotal: (total: number) => string;
  color?: string;
  barColor?: string;
  /** Singular/plural label suffix in the hover tooltip. */
  tooltipLabel?: (value: number) => string;
  /** Format raw bucket value for tooltip display (defaults to as-is). */
  formatTooltipValue?: (value: number) => string;
}) {
  if (!data || data.every((v) => v === 0)) {
    return <span className="text-text-dimmed">–</span>;
  }

  const total = data.reduce((sum, v) => sum + v, 0);
  const max = Math.max(...data);

  // Map the 24-bucket array to dated points so the tooltip can show the
  // hour each bar represents. Bucket i is `23 - i` hours before now.
  const now = new Date();
  const chartData: SparklineDatum[] = data.map((count, i) => ({
    date: new Date(now.getTime() - (data.length - 1 - i) * 3600_000),
    count,
  }));

  return (
    <div className="flex items-start gap-2">
      <div className="h-6 w-[7rem] rounded-sm">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <YAxis domain={[0, max || 1]} hide />
            <Tooltip
              cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
              content={
                <SparklineTooltip
                  tooltipLabel={tooltipLabel}
                  formatTooltipValue={formatTooltipValue}
                />
              }
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 1000 }}
              animationDuration={0}
            />
            <Bar
              dataKey="count"
              fill={barColor}
              strokeWidth={0}
              isAnimationActive={false}
              minPointSize={1}
            />
            <ReferenceLine y={0} stroke="#2C3034" strokeWidth={1} />
            {max > 0 && (
              <ReferenceLine y={max} stroke="#4D525B" strokeDasharray="4 4" strokeWidth={1} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <span className={cn("-mt-1 text-xs tabular-nums", color)}>{formatTotal(total)}</span>
    </div>
  );
}

function SparklineTooltip({
  active,
  payload,
  tooltipLabel,
  formatTooltipValue,
}: TooltipProps<number, string> & {
  tooltipLabel?: (value: number) => string;
  formatTooltipValue?: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0].payload as SparklineDatum;
  const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
  const formattedDate = formatDateTime(date, "UTC", [], false, true);
  const displayValue = formatTooltipValue ? formatTooltipValue(entry.count) : String(entry.count);
  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-charcoal-650 pb-2">{formattedDate}</Header3>
        <div className="mt-2 text-xs text-text-bright">
          <span className="tabular-nums">{displayValue}</span>{" "}
          {tooltipLabel && <span className="text-text-dimmed">{tooltipLabel(entry.count)}</span>}
        </div>
      </div>
    </TooltipPortal>
  );
}
