import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
  type TooltipProps,
} from "recharts";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PromptsNone } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { DateTime, formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { cn } from "~/utils/cn";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { PromptPresenter } from "~/presenters/v3/PromptPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3PromptsPath } from "~/utils/pathBuilder";
import { LinkButton } from "~/components/primitives/Buttons";
import { BookOpenIcon } from "@heroicons/react/24/solid";

export const meta: MetaFunction = () => {
  return [{ title: "Prompts | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(project.organizationId, "standard");
  const presenter = new PromptPresenter(clickhouse);
  const prompts = await presenter.listPrompts(project.id, environment.id);

  const sparklines = await presenter.getUsageSparklines(
    environment.id,
    prompts.map((p) => p.slug)
  );

  return typedjson({ prompts, sparklines });
};

export default function PromptsPage() {
  const { prompts, sparklines } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (prompts.length === 0) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Prompts" />
        </NavBar>
        <PageBody>
          <MainCenteredContainer className="max-w-lg">
            <PromptsNone />
          </MainCenteredContainer>
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Prompts" />
        <PageAccessories>
          <LinkButton variant="docs/small" LeadingIcon={BookOpenIcon} to={docsPath("ai/prompts")}>
            Prompts docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <Table containerClassName="border-t-0">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>ID</TableHeaderCell>
              <TableHeaderCell>Slug</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell
                tooltip={
                  <div className="flex max-w-[16rem] flex-col gap-3 p-1 pb-2">
                    <div className="flex flex-col gap-2">
                      <div>
                        <div className="mb-0.5 flex items-center gap-2">
                          <span className="size-1.5 shrink-0 rounded-full bg-success" />
                          <Paragraph variant="small" className="!text-wrap text-text-bright">
                            Latest version
                          </Paragraph>
                        </div>
                        <Paragraph variant="small" className="!text-wrap pl-3.5 text-text-dimmed">
                          Running the most recently published version.
                        </Paragraph>
                      </div>
                      <div>
                        <div className="mb-0.5 flex items-center gap-2">
                          <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                          <Paragraph variant="small" className="!text-wrap text-text-bright">
                            Version overridden
                          </Paragraph>
                        </div>
                        <Paragraph variant="small" className="!text-wrap pl-3.5 text-text-dimmed">
                          Pinned to an older version instead of the latest.
                        </Paragraph>
                      </div>
                    </div>
                  </div>
                }
                disableTooltipHoverableContent
              >
                Version
              </TableHeaderCell>
              <TableHeaderCell>Usage (24h)</TableHeaderCell>
              <TableHeaderCell alignment="right">Last updated</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prompts.length === 0 ? (
              <TableBlankRow colSpan={7}>No prompts found</TableBlankRow>
            ) : (
              prompts.map((prompt) => {
                const path = `${v3PromptsPath(organization, project, environment)}/${prompt.slug}`;
                const activeVersion = prompt.overrideVersion ?? prompt.currentVersion;
                const isOverride = !!prompt.overrideVersion;

                return (
                  <TableRow key={prompt.id}>
                    <TableCell to={path} isTabbableCell>
                      <TruncatedCopyableValue value={prompt.friendlyId} />
                    </TableCell>
                    <TableCell to={path}>{prompt.slug}</TableCell>
                    <TableCell to={path}>
                      {prompt.description ? (
                        <span
                          title={prompt.description.length > 80 ? prompt.description : undefined}
                        >
                          {prompt.description.length > 80
                            ? prompt.description.slice(0, 80) + "…"
                            : prompt.description}
                        </span>
                      ) : (
                        <span>-</span>
                      )}
                    </TableCell>
                    <TableCell to={path}>
                      <span>{prompt.defaultModel ?? <span>-</span>}</span>
                    </TableCell>
                    <TableCell to={path}>
                      {activeVersion ? (
                        <div className="flex items-center gap-1.5">
                          <div
                            className={`size-1.5 rounded-full ${
                              isOverride ? "bg-warning" : "bg-success"
                            }`}
                          />
                          <span>v{activeVersion.version}</span>
                        </div>
                      ) : (
                        <span>-</span>
                      )}
                    </TableCell>
                    <TableCell to={path}>
                      <UsageSparkline data={sparklines[prompt.slug]} />
                    </TableCell>
                    <TableCell to={path} alignment="right">
                      <DateTime date={prompt.updatedAt} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </PageBody>
    </PageContainer>
  );
}

type UsageDatum = { date: Date; count: number };

function UsageSparkline({ data }: { data?: number[] }) {
  if (!data || data.every((v) => v === 0)) {
    return <span className="text-text-dimmed">–</span>;
  }

  const total = data.reduce((a, b) => a + b, 0);
  const max = Math.max(...data);

  // Map the 24-bucket array to dated points so the tooltip can show the
  // hour each bar represents. Bucket i is `23 - i` hours before now.
  const now = new Date();
  const chartData: UsageDatum[] = data.map((count, i) => ({
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
              content={<UsageSparklineTooltip />}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 1000 }}
              animationDuration={0}
            />
            <Bar
              dataKey="count"
              fill="#3B82F6"
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
      <span className={cn("-mt-1 text-xs tabular-nums text-blue-400")}>
        {total.toLocaleString()}
      </span>
    </div>
  );
}

function UsageSparklineTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0].payload as UsageDatum;
  const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
  const formattedDate = formatDateTime(date, "UTC", [], false, true);
  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-charcoal-650 pb-2">{formattedDate}</Header3>
        <div className="mt-2 text-xs text-text-bright">
          <span className="tabular-nums">{entry.count.toLocaleString()}</span>{" "}
          <span className="text-text-dimmed">{entry.count === 1 ? "call" : "calls"}</span>
        </div>
      </div>
    </TooltipPortal>
  );
}
