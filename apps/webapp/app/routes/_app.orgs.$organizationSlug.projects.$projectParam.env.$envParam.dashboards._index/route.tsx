import { PlusIcon } from "@heroicons/react/20/solid";
import { Link, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AIMetricsIcon } from "~/assets/icons/AIMetricsIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { CreateDashboardPageButton } from "~/components/navigation/DashboardDialogs";
import { Header1, Header2 } from "~/components/primitives/Headers";
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
        <div className="mx-auto mt-8 flex w-full max-w-5xl flex-col gap-4 p-6">
          <div>
            <Header1 spacing className="text-text-bright">
              Select a dashboard
            </Header1>
            <Paragraph variant="small" className="text-text-dimmed">
              Browse the built-in dashboards or create your own custom dashboard with your own
              charts and widgets.
            </Paragraph>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DashboardCta
              to={runsPath}
              icon={<RunsIcon className="size-7 text-runs" />}
              title="Run metrics"
              description="Overview of runs, latency, throughput and queue health for this environment."
            />
            <DashboardCta
              to={agentsPath}
              icon={<AIMetricsIcon className="size-7 text-aiMetrics" />}
              title="AI metrics"
              description="LLM-level metrics: cost, tokens, latency, and per-model usage for your AI agents."
            />
            <CreateDashboardPageButton
              organization={organization}
              project={project}
              environment={environment}
            >
              <DashboardCta
                icon={<PlusIcon className="size-7 text-text-bright" />}
                title="Create your own dashboard"
                description="Build a dashboard with custom widgets and queries."
              />
            </CreateDashboardPageButton>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

const CTA_CLASSNAME = cn(
  "group flex h-full min-h-[10rem] flex-col gap-3 rounded-lg border border-grid-bright bg-background-bright p-5 text-left transition-colors",
  "hover:border-charcoal-600 hover:bg-charcoal-750"
);

type DashboardCtaProps = {
  icon: ReactNode;
  title: string;
  description: string;
};

type DashboardCtaLinkProps = DashboardCtaProps & { to: string };
type DashboardCtaButtonProps = DashboardCtaProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { to?: undefined };

const DashboardCta = forwardRef<HTMLElement, DashboardCtaLinkProps | DashboardCtaButtonProps>(
  function DashboardCta({ icon, title, description, ...rest }, ref) {
    const body = (
      <>
        <div className="flex items-center justify-between">{icon}</div>
        <div className="flex flex-col gap-1">
          <Header2 className="text-text-bright">{title}</Header2>
          <Paragraph variant="small" className="text-text-dimmed">
            {description}
          </Paragraph>
        </div>
      </>
    );

    if ("to" in rest && rest.to) {
      return (
        <Link ref={ref as React.Ref<HTMLAnchorElement>} to={rest.to} className={CTA_CLASSNAME}>
          {body}
        </Link>
      );
    }

    const { to: _to, ...buttonProps } = rest as DashboardCtaButtonProps;
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type="button"
        className={CTA_CLASSNAME}
        {...buttonProps}
      >
        {body}
      </button>
    );
  }
);
