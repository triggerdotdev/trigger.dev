import { BookOpenIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense, useMemo } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import type { ChartConfig } from "~/components/primitives/charts/Chart";
import { Chart } from "~/components/primitives/charts/ChartCompound";
import { Header1, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  tasksDashboardPresenter,
  type DailyRunPoint,
} from "~/presenters/v3/TasksDashboardPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  docsPath,
  EnvironmentParamSchema,
  v3AgentsPath,
  v3RunsPath,
  v3SchedulesPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [{ title: "Tasks | Trigger.dev" }];
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

  const result = await tasksDashboardPresenter.call({
    organizationId: project.organizationId,
    environmentId: environment.id,
    environmentType: environment.type,
  });

  return typeddefer(result);
};

const isoDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "utc",
});

function formatDay(value: string) {
  // value is a YYYY-MM-DD date string
  const d = new Date(value + "T00:00:00Z");
  return isoDateFormatter.format(d);
}

const STANDARD_EXAMPLE = `import { task } from "@trigger.dev/sdk";

export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { name: string }) => {
    return { greeting: \`Hello, \${payload.name}!\` };
  },
});
`;

const SCHEDULED_EXAMPLE = `import { schedules } from "@trigger.dev/sdk";

export const dailyReport = schedules.task({
  id: "daily-report",
  cron: "0 9 * * *",
  run: async (payload) => {
    // Runs every day at 9am UTC
    return { ranAt: payload.timestamp };
  },
});
`;

const AGENT_EXAMPLE = `import { agent } from "@trigger.dev/sdk/ai";

export const supportAgent = agent({
  id: "support-agent",
  model: "anthropic/claude-sonnet-4-6",
  instructions: "You are a helpful customer support agent.",
});
`;

export default function TasksDashboardPage() {
  const { counts, series } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
      </NavBar>
      <PageBody scrollable={true}>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
          <Header1 className="text-text-bright">Tasks overview</Header1>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Suspense fallback={<PanelSkeleton title="Agent tasks" />}>
            <TypedAwait resolve={series}>
              {(s) => (
                <TaskTypePanel
                  title="Agent tasks"
                  count={counts.agents}
                  description="AI agents are tasks that can call LLMs, use tools, and run multi-step conversations. Use them to power chat experiences, intelligent automations, or autonomous workflows."
                  example="A support agent that drafts replies using your docs as context."
                  data={s.agents}
                  seriesColor="hsl(280 80% 65%)"
                  listingPath={v3AgentsPath(organization, project, environment)}
                  docsHref={docsPath("v3/agents")}
                  emptyTitle="You don't have any agents yet"
                  emptyDescription="Create an AI agent to call LLMs, use tools, and run multi-step conversations from a Trigger.dev task."
                  emptyCta="Create your first agent"
                  exampleCode={AGENT_EXAMPLE}
                />
              )}
            </TypedAwait>
          </Suspense>
          <Suspense fallback={<PanelSkeleton title="Standard tasks" />}>
            <TypedAwait resolve={series}>
              {(s) => (
                <TaskTypePanel
                  title="Standard tasks"
                  count={counts.standard}
                  description="Standard tasks are durable background functions you trigger from your code. Use them for any async work that needs retries, observability, and reliable execution."
                  example="Process an uploaded video, send a transactional email, or sync data from a third-party API."
                  data={s.standard}
                  seriesColor="hsl(200 80% 60%)"
                  listingPath={v3RunsPath(organization, project, environment)}
                  docsHref={docsPath("v3/tasks-overview")}
                  emptyTitle="You don't have any standard tasks yet"
                  emptyDescription="Standard tasks are the building block of Trigger.dev. Define one in your codebase and trigger it from anywhere."
                  emptyCta="Create your first task"
                  exampleCode={STANDARD_EXAMPLE}
                />
              )}
            </TypedAwait>
          </Suspense>
          <Suspense fallback={<PanelSkeleton title="Scheduled tasks" />}>
            <TypedAwait resolve={series}>
              {(s) => (
                <TaskTypePanel
                  title="Scheduled tasks"
                  count={counts.scheduled}
                  description="Scheduled tasks run automatically on a cron schedule. Attach as many schedules to a task as you need (e.g. one per customer)."
                  example="Generate a nightly report, refresh a cache every 5 minutes, or send a weekly digest email."
                  data={s.scheduled}
                  seriesColor="hsl(30 90% 60%)"
                  listingPath={v3SchedulesPath(organization, project, environment)}
                  docsHref={docsPath("v3/tasks-scheduled")}
                  emptyTitle="You don't have any scheduled tasks yet"
                  emptyDescription="Schedule a task to run on a cron expression. Once you've defined a `schedules.task` you can attach one or many schedules to it."
                  emptyCta="Create your first scheduled task"
                  exampleCode={SCHEDULED_EXAMPLE}
                />
              )}
            </TypedAwait>
          </Suspense>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function PanelSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <Card.Header>{title}</Card.Header>
      <Card.Content className="flex h-72 items-center justify-center">
        <Spinner className="size-6" />
      </Card.Content>
    </Card>
  );
}

type TaskTypePanelProps = {
  title: string;
  count: number;
  description: string;
  example: string;
  data: DailyRunPoint[];
  seriesColor: string;
  listingPath: string;
  docsHref: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyCta: string;
  exampleCode: string;
};

function TaskTypePanel(props: TaskTypePanelProps) {
  const {
    title,
    count,
    description,
    example,
    data,
    seriesColor,
    listingPath,
    docsHref,
    emptyTitle,
    emptyDescription,
    emptyCta,
    exampleCode,
  } = props;

  const hasData = count > 0;

  const chartConfig = useMemo<ChartConfig>(
    () => ({
      count: {
        label: "Runs",
        color: seriesColor,
      },
    }),
    [seriesColor]
  );

  return (
    <Card>
      <Card.Header>
        <span className="truncate">{title}</span>
        <Card.Accessory>
          <span className="shrink-0 whitespace-nowrap text-base font-medium tabular-nums leading-none text-text-bright">
            {count.toLocaleString()}
          </span>
        </Card.Accessory>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <div className="h-40">
          <Chart.Root
            config={chartConfig}
            data={data}
            dataKey="day"
            labelFormatter={(value) => formatDay(value as string)}
            fillContainer
          >
            <Chart.Bar
              tooltipLabelFormatter={(label) => formatDay(label)}
              xAxisProps={{ tickFormatter: (value) => formatDay(value) }}
            />
          </Chart.Root>
        </div>
        {hasData ? (
          <>
            <Paragraph variant="small" className="px-2 text-text-dimmed">
              {description}
            </Paragraph>
            <div className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1">
              <LinkButton to={listingPath} variant="secondary/small">
                View all
              </LinkButton>
              <LinkButton to={docsHref} variant="docs/small" LeadingIcon={BookOpenIcon}>
                Read docs
              </LinkButton>
            </div>
          </>
        ) : (
          <EmptyContent
            title={emptyTitle}
            description={emptyDescription}
            example={example}
            listingPath={listingPath}
            docsHref={docsHref}
            cta={emptyCta}
            exampleCode={exampleCode}
          />
        )}
      </Card.Content>
    </Card>
  );
}

function EmptyContent({
  title,
  description,
  example,
  listingPath,
  docsHref,
  cta,
  exampleCode,
}: {
  title: string;
  description: string;
  example: string;
  listingPath: string;
  docsHref: string;
  cta: string;
  exampleCode: string;
}) {
  const copyExample = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(exampleCode).catch(() => {
        /* swallow */
      });
    }
  };

  return (
    <>
      <Header3 className="px-2 text-text-bright">{title}</Header3>
      <Paragraph variant="small" className="px-2 text-text-dimmed">
        {description}
      </Paragraph>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1">
        <LinkButton to={listingPath} variant="primary/small">
          {cta}
        </LinkButton>
        <button
          type="button"
          onClick={copyExample}
          className="inline-flex items-center rounded border border-charcoal-700 bg-background-bright px-2 py-1 text-xs text-text-dimmed transition-colors hover:text-text-bright"
        >
          Copy example code
        </button>
        <LinkButton to={docsHref} variant="docs/small" LeadingIcon={BookOpenIcon}>
          Read docs
        </LinkButton>
      </div>
    </>
  );
}
