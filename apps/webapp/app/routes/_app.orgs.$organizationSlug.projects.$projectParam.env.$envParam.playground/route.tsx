import { BookOpenIcon, ChevronUpDownIcon, CpuChipIcon } from "@heroicons/react/20/solid";
import { json, type MetaFunction } from "@remix-run/node";
import { Outlet, useLoaderData, useNavigate, useParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Table, TableBody, TableCell, TableRow } from "~/components/primitives/Table";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { playgroundPresenter } from "~/presenters/v3/PlaygroundPresenter.server";
import { RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { requireUser } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3PlaygroundAgentPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [{ title: "Playground | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const [agents, backgroundWorkers, regionsResult] = await Promise.all([
    playgroundPresenter.listAgents({
      environmentId: environment.id,
      environmentType: environment.type,
    }),
    $replica.backgroundWorker.findMany({
      where: { runtimeEnvironmentId: environment.id },
      select: { version: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    new RegionsPresenter().call({
      userId: user.id,
      projectSlug: projectParam,
      isAdmin: user.admin || user.isImpersonating,
    }),
  ]);

  return json({
    agents,
    versions: backgroundWorkers.map((w) => w.version),
    regions: regionsResult.regions,
    isDev: environment.type === "DEVELOPMENT",
  });
};

export default function PlaygroundPage() {
  const { agents } = useLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const params = useParams();
  const navigate = useNavigate();
  const selectedAgent = params.agentParam ?? "";
  const selectedAgentType = (() => {
    if (!selectedAgent) return null;
    const agent = agents.find((a) => a.slug === selectedAgent);
    const config = (agent?.config ?? null) as { type?: string } | null;
    return config?.type ?? null;
  })();

  if (agents.length === 0) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Test" />
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
                Test lets you exercise your AI agents with an interactive chat interface, realtime
                streaming, and conversation history.
              </Paragraph>
              <Paragraph spacing variant="small">
                Define a chat agent using <InlineCode variant="small">chat.agent()</InlineCode>:
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
        {selectedAgent ? (
          <PageTitle
            title={
              <div className="flex items-center gap-1">
                <Select
                  value={selectedAgent}
                  setValue={(slug) => {
                    if (slug && typeof slug === "string" && slug !== selectedAgent) {
                      navigate(v3PlaygroundAgentPath(organization, project, environment, slug));
                    }
                  }}
                  icon={<CubeSparkleIcon className="mr-1 size-4 text-agents" />}
                  text={(val) => val || undefined}
                  variant="minimal/small"
                  items={agents}
                  filter={(item, search) => item.slug.toLowerCase().includes(search.toLowerCase())}
                  className="-ml-2"
                  dropdownIcon={
                    <ChevronUpDownIcon className="size-4 flex-none text-text-dimmed transition group-hover:text-text-bright group-focus:text-text-bright" />
                  }
                >
                  {(matches) =>
                    matches.map((a) => (
                      <SelectItem key={a.slug} value={a.slug}>
                        <div className="flex items-center gap-2">
                          <CubeSparkleIcon className="size-4 text-agents" />
                          <span className="text-text-bright">{a.slug}</span>
                        </div>
                      </SelectItem>
                    ))
                  }
                </Select>
                {selectedAgentType && (
                  <Badge variant="extra-small">{formatAgentType(selectedAgentType)}</Badge>
                )}
              </div>
            }
          />
        ) : (
          <PageTitle title="Test" />
        )}
      </NavBar>
      <PageBody scrollable={!selectedAgent}>
        {selectedAgent ? (
          <Outlet />
        ) : (
          <MainCenteredContainer className="max-w-xl">
            <div className="flex flex-col gap-4 py-8">
              <Header2>Choose an agent to start a conversation</Header2>
              <Table containerClassName="overflow-hidden rounded-md border-l border-r border-b border-grid-dimmed [&_tbody_tr:last-child]:after:hidden">
                <TableBody>
                  {agents.map((agent) => {
                    const path = v3PlaygroundAgentPath(
                      organization,
                      project,
                      environment,
                      agent.slug
                    );
                    return (
                      <TableRow key={agent.slug}>
                        <TableCell to={path} isTabbableCell>
                          <div className="flex items-center gap-2">
                            <CubeSparkleIcon className="size-5 text-agents" />
                            <span className="text-sm">{agent.slug}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </MainCenteredContainer>
        )}
      </PageBody>
    </PageContainer>
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
