import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PromptsNone } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { Badge } from "~/components/primitives/Badge";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
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
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3PromptsPath } from "~/utils/pathBuilder";

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

  const presenter = new PromptPresenter(clickhouseClient);
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
      </NavBar>
      <PageBody scrollable={false}>
        <Table containerClassName="border-t-0">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>ID</TableHeaderCell>
              <TableHeaderCell>Prompt</TableHeaderCell>
              <TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>Current</TableHeaderCell>
              <TableHeaderCell>Usage (24h)</TableHeaderCell>
              <TableHeaderCell alignment="right">Last updated</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prompts.length === 0 ? (
              <TableBlankRow colSpan={6}>No prompts found</TableBlankRow>
            ) : (
              prompts.map((prompt) => {
                const path = `${v3PromptsPath(organization, project, environment)}/${prompt.slug}`;

                return (
                  <TableRow key={prompt.id}>
                    <TableCell to={path} isTabbableCell>
                      <TruncatedCopyableValue value={prompt.friendlyId} />
                    </TableCell>
                    <TableCell to={path}>
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-bright">{prompt.slug}</span>
                          {prompt.hasOverride && (
                            <Badge variant="extra-small" className="border-amber-500/30 text-amber-400">
                              override
                            </Badge>
                          )}
                        </div>
                        {prompt.description && (
                          <span className="text-xs text-text-dimmed">{prompt.description}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell to={path}>
                      <span className="text-text-dimmed">
                        {prompt.defaultModel ?? <span className="text-charcoal-500">-</span>}
                      </span>
                    </TableCell>
                    <TableCell to={path}>
                      {prompt.currentVersion ? (
                        <div className="flex items-center gap-1.5">
                          <div className="size-1.5 rounded-full bg-green-500" />
                          <span className="text-text-bright">
                            v{prompt.currentVersion.version}
                          </span>
                        </div>
                      ) : (
                        <span className="text-charcoal-500">-</span>
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

function UsageSparkline({ data }: { data?: number[] }) {
  if (!data || data.every((v) => v === 0)) {
    return <span className="text-charcoal-500">-</span>;
  }

  const total = data.reduce((a, b) => a + b, 0);
  const chartData = data.map((value) => ({ value }));

  return (
    <div className="flex items-center gap-2">
      <div className="h-6 w-16">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 1, right: 0, bottom: 1, left: 0 }}>
            <defs>
              <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="value"
              stroke="#3b82f6"
              strokeWidth={1.5}
              fill="url(#sparkFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <span className="text-xs tabular-nums text-text-dimmed">{total.toLocaleString()}</span>
    </div>
  );
}
