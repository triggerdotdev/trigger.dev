import { PlusIcon } from "@heroicons/react/20/solid";
import { Link, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AIMetricsIcon } from "~/assets/icons/AIMetricsIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { CreateDashboardPageButton } from "~/components/navigation/DashboardDialogs";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { EnvironmentParamSchema, v3BuiltInDashboardPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [{ title: "Dashboards | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  return typedjson({ ok: true });
};

export default function Page() {
  useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const runsPath = v3BuiltInDashboardPath(organization, project, environment, "overview");
  const agentsPath = v3BuiltInDashboardPath(organization, project, environment, "llm");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Dashboards" />
      </NavBar>
      <PageBody scrollable={true}>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
          <div>
            <Header2 className="text-text-bright">Pick a dashboard</Header2>
            <Paragraph variant="small" className="text-text-dimmed">
              Browse the built-in dashboards or create your own custom dashboard with the widgets
              and queries you care about.
            </Paragraph>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DashboardCta
              to={runsPath}
              icon={<RunsIcon className="size-7 text-runs" />}
              title="Runs dashboard"
              description="Overview of runs, latency, throughput and queue health for this environment."
            />
            <DashboardCta
              to={agentsPath}
              icon={<AIMetricsIcon className="size-7 text-aiMetrics" />}
              title="Agents dashboard"
              description="LLM-level metrics: cost, tokens, latency, and per-model usage for your AI agents."
            />
            <CreateDashboardCta
              organization={organization}
              project={project}
              environment={environment}
            />
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function DashboardCta({
  to,
  icon,
  title,
  description,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "group flex h-full min-h-[10rem] flex-col gap-3 rounded-lg border border-grid-bright bg-background-bright p-5 transition-colors",
        "hover:border-charcoal-500 hover:bg-background-dimmed"
      )}
    >
      <div className="flex items-center justify-between">
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <Header2 className="text-text-bright">{title}</Header2>
        <Paragraph variant="small" className="text-text-dimmed">
          {description}
        </Paragraph>
      </div>
    </Link>
  );
}

function CreateDashboardCta({
  organization,
  project,
  environment,
}: {
  organization: ReturnType<typeof useOrganization>;
  project: ReturnType<typeof useProject>;
  environment: ReturnType<typeof useEnvironment>;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[10rem] flex-col gap-3 rounded-lg border border-dashed border-grid-bright bg-background-bright p-5 transition-colors",
        "hover:border-charcoal-500"
      )}
    >
      <PlusIcon className="size-7 text-text-dimmed" />
      <div className="flex flex-col gap-1">
        <Header2 className="text-text-bright">Create your own dashboard</Header2>
        <Paragraph variant="small" className="text-text-dimmed">
          Build a dashboard with custom widgets and queries.
        </Paragraph>
      </div>
      <div className="mt-auto">
        <CreateDashboardPageButton
          organization={organization}
          project={project}
          environment={environment}
        />
      </div>
    </div>
  );
}
