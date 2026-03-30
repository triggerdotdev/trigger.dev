import { CpuChipIcon } from "@heroicons/react/20/solid";
import { json, type MetaFunction } from "@remix-run/node";
import { Outlet, useNavigate, useParams, useLoaderData } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Select,
  SelectItem,
} from "~/components/primitives/Select";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type PlaygroundAgent,
  playgroundPresenter,
} from "~/presenters/v3/PlaygroundPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3PlaygroundAgentPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [{ title: "Playground | Trigger.dev" }];
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

  const agents = await playgroundPresenter.listAgents({
    environmentId: environment.id,
    environmentType: environment.type,
  });

  return json({ agents });
};

export default function PlaygroundPage() {
  const { agents } = useLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigate = useNavigate();
  const params = useParams();
  const selectedAgent = params.agentParam ?? "";

  if (agents.length === 0) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Playground" />
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
        <PageTitle title="Playground" />
        <PageAccessories>
          <Select
            value={selectedAgent}
            setValue={(slug) => {
              if (slug && typeof slug === "string") {
                navigate(v3PlaygroundAgentPath(organization, project, environment, slug));
              }
            }}
            icon={<CpuChipIcon className="size-4 text-indigo-500" />}
            text={(val) => val || undefined}
            placeholder="Select an agent..."
            variant="tertiary/small"
            items={agents}
            filter={(item, search) =>
              item.slug.toLowerCase().includes(search.toLowerCase())
            }
          >
            {(matches) =>
              matches.map((agent, index) => (
                <SelectItem key={agent.slug} value={agent.slug}>
                  <div className="flex items-center gap-2">
                    <CpuChipIcon className="size-3.5 text-indigo-500" />
                    <span>{agent.slug}</span>
                  </div>
                </SelectItem>
              ))
            }
          </Select>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {selectedAgent ? (
          <Outlet />
        ) : (
          <MainCenteredContainer>
            <div className="flex flex-col items-center gap-4 py-20">
              <CpuChipIcon className="size-10 text-indigo-500/50" />
              <Header2 className="text-text-dimmed">Select an agent</Header2>
              <Paragraph variant="small" className="max-w-md text-center text-text-dimmed">
                Choose an agent from the dropdown to start a conversation.
              </Paragraph>
            </div>
          </MainCenteredContainer>
        )}
      </PageBody>
    </PageContainer>
  );
}
