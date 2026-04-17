import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Bar, BarChart, ResponsiveContainer } from "recharts";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PromptsNone } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
              <TableHeaderCell>Version</TableHeaderCell>
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
          <BarChart data={chartData} margin={{ top: 1, right: 0, bottom: 1, left: 0 }}>
            <Bar dataKey="value" fill="#3b82f6" radius={[1, 1, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <span className="text-xs tabular-nums text-text-dimmed">{total.toLocaleString()}</span>
    </div>
  );
}
