import { BookOpenIcon, CpuChipIcon } from "@heroicons/react/20/solid";
import { json, type MetaFunction } from "@remix-run/node";
import { Outlet, useNavigate, useParams, useLoaderData } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
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
import { playgroundPresenter } from "~/presenters/v3/PlaygroundPresenter.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3PlaygroundAgentPath } from "~/utils/pathBuilder";

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
          <MainCenteredContainer className="max-w-2xl">
            <InfoPanel
              title="Create your first agent"
              icon={CpuChipIcon}
              iconClassName="text-indigo-500"
              panelClassName="max-w-2xl"
              accessory={
                <LinkButton
                  to={docsPath("ai-chat/overview")}
                  variant="docs/small"
                  LeadingIcon={BookOpenIcon}
                >
                  Agent docs
                </LinkButton>
              }
            >
              <Paragraph spacing variant="small">
                The Playground lets you test your AI agents with an interactive chat interface,
                realtime streaming, and conversation history.
              </Paragraph>
              <Paragraph spacing variant="small">
                Define a chat agent using{" "}
                <InlineCode variant="small">chat.agent()</InlineCode>:
              </Paragraph>
              <CodeBlock
                code={`import { chat } from "@trigger.dev/sdk/ai";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export const myAgent = chat.agent({
  id: "my-agent",
  run: async ({ messages, signal }) => {
    return streamText({
      model: openai("gpt-4o"),
      messages,
      abortSignal: signal,
    });
  },
});`}
                showLineNumbers={false}
                showOpenInModal={false}
              />
              <Paragraph variant="small" className="mt-2">
                Deploy your project and your agents will appear here ready to test.
              </Paragraph>
            </InfoPanel>
          </MainCenteredContainer>
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Playground" />
      </NavBar>
      <PageBody scrollable={false}>
        {selectedAgent ? (
          <Outlet />
        ) : (
          <MainCenteredContainer>
            <div className="flex flex-col items-center gap-4 py-20">
              <CpuChipIcon className="size-10 text-indigo-500/50" />
              <Header2 className="text-text-dimmed">Select an agent</Header2>
              <Paragraph variant="small" className="mb-2 max-w-md text-center text-text-dimmed">
                Choose an agent to start a conversation.
              </Paragraph>
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
                  matches.map((agent) => (
                    <SelectItem key={agent.slug} value={agent.slug}>
                      <div className="flex items-center gap-2">
                        <CpuChipIcon className="size-3.5 text-indigo-500" />
                        <span>{agent.slug}</span>
                      </div>
                    </SelectItem>
                  ))
                }
              </Select>
            </div>
          </MainCenteredContainer>
        )}
      </PageBody>
    </PageContainer>
  );
}
