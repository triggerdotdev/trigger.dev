import { ArrowUpRightIcon } from "@heroicons/react/20/solid";
import { NODE_RUNTIME_UPDATE_MAJOR } from "@trigger.dev/core/v3";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { listCurrentProductionProjectRuntimes } from "~/services/projectRuntimeUpdates.server";
import { OrganizationParamsSchema, v3DeploymentsPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Runtime updates");

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: {
      action: "read",
      resource: { type: "deployments" },
      message: "With your current role, you can't view runtime updates.",
    },
  },
  async ({ context, params }) => {
    const runtimes = await listCurrentProductionProjectRuntimes({
      organizationId: context.organizationId,
    });

    return typedjson({
      organizationSlug: params.organizationSlug,
      runtimes: runtimes.filter(
        (runtime) => runtime.deployment?.nodeMajor === NODE_RUNTIME_UPDATE_MAJOR
      ),
    });
  }
);

export default function Page() {
  const { organizationSlug, runtimes } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <PageBody>
        <MainHorizontallyCenteredContainer>
          <header className="mb-8 max-w-2xl">
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-warning">
              Runtime update available
            </p>
            <Header2>Move Production projects to Node.js 24</Header2>
            <Paragraph className="mt-2 text-text-dimmed">
              {runtimes.length} {runtimes.length === 1 ? "project is" : "projects are"} currently
              running Node.js {NODE_RUNTIME_UPDATE_MAJOR} in Production. Update every project listed
              below.
            </Paragraph>
          </header>

          {runtimes.length === 0 ? (
            <div className="border border-grid-bright bg-background-bright px-5 py-6">
              <Header2 className="text-base">Everything is up to date</Header2>
              <Paragraph className="mt-1 text-text-dimmed">
                No Production projects are currently using Node.js {NODE_RUNTIME_UPDATE_MAJOR}.
              </Paragraph>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="border border-warning/30 bg-warning/5 px-5 py-4">
                <p className="text-sm font-medium text-text-bright">Update every listed project</p>
                <Paragraph className="mt-1 text-sm text-text-dimmed">
                  Update each project listed below in its <code>trigger.config.ts</code>, then
                  deploy a new Production version.
                </Paragraph>
                <pre className="mt-3 overflow-x-auto border border-grid-bright bg-background-dimmed px-3 py-2.5 font-mono text-sm leading-6 text-text-bright">
                  <code>{`export default defineConfig({\n  project: "<your-project-ref>",\n  runtime: "node-24",\n});`}</code>
                </pre>
                <Paragraph className="mt-3 text-sm text-text-dimmed">
                  Prefer the command line? Run{" "}
                  <code>npx trigger.dev@latest projects list --needs-update</code> to find projects
                  that need an update.
                </Paragraph>
              </div>

              <div className="overflow-hidden border border-grid-bright bg-background-bright">
                {runtimes.map(({ project, environment, deployment }) => {
                  if (!deployment) return null;

                  return (
                    <div
                      key={project.externalRef}
                      className="grid gap-5 border-b border-grid-bright p-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-text-bright">{project.name}</p>
                        <p className="mt-1 truncate font-mono text-xs text-text-dimmed">
                          {project.externalRef}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-dimmed">
                          <RuntimeIcon
                            runtime={deployment.runtime}
                            runtimeVersion={deployment.runtimeVersion}
                            withLabel
                          />
                          <span>
                            Production deployed {deployment.deployedAt?.toLocaleString() ?? "-"}
                          </span>
                        </div>
                      </div>
                      <LinkButton
                        variant="secondary/small"
                        LeadingIcon={ArrowUpRightIcon}
                        to={v3DeploymentsPath(
                          { slug: organizationSlug },
                          { slug: project.slug },
                          { slug: environment.slug }
                        )}
                      >
                        View deployment
                      </LinkButton>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
