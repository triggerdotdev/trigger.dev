import { Tab } from "@headlessui/react";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import classNames from "classnames";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import CodeBlock from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { InstallPackages } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import {
  PrimaryButton,
  PrimaryLink,
  TertiaryLink,
} from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import {
  LargeBox,
  LargeBoxList,
  Underlined,
  UnderlinedList,
} from "~/components/primitives/Tabs";
import { Body } from "~/components/primitives/text/Body";
import { Header4 } from "~/components/primitives/text/Headers";
import { Title } from "~/components/primitives/text/Title";
import {
  exampleProjects,
  fromScratchProjects,
} from "~/components/samples/samplesList";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getIntegrationMetadatas } from "~/models/integrations.server";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { requireUserId } from "~/services/session.server";

const urlSearchParamsSchema = z.object({
  date: z.coerce.number().transform((value) => new Date(value)),
});

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);

  //add the date to the url so we can tell if a workflow is new
  const url = new URL(request.url);
  const searchObject = Object.fromEntries(url.searchParams ?? {});
  const result = urlSearchParamsSchema.safeParse(searchObject);
  if (!result.success) {
    url.searchParams.set("date", new Date().getTime().toString());
    throw redirect(url.toString());
  }

  const providers = getIntegrationMetadatas(false);

  return typedjson({ providers });
};

export const action = async ({ request, params }: ActionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");

  const url = new URL(request.url);
  const result = urlSearchParamsSchema.safeParse(
    Object.fromEntries(url.searchParams)
  );

  if (!result.success) {
    console.error("workflows.new action: Invalid date");
    return typedjson({ hasNewWorkflows: false, newWorkflow: undefined });
  }

  const organization = await getOrganizationFromSlug({
    slug: organizationSlug,
    userId,
  });

  const newWorkflow = organization?.workflows.find((workflow) => {
    return workflow.createdAt > result.data.date;
  });

  return typedjson({
    hasNewWorkflows: newWorkflow ? true : false,
    newWorkflow,
  });
};

const maxWidth = "max-w-4xl";
const subTitle = "text-slate-200 font-semibold mb-4";

export default function NewWorkflowPage() {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be defined");
  invariant(environment, "Environment must be defined");

  return (
    <Container>
      <Title>Create a new workflow</Title>
      <div className={maxWidth}>
        <Header4 size="regular" className={subTitle}>
          1. Install the Trigger.dev package
        </Header4>
        <InstallPackages packages={"@trigger.dev/sdk"} />
        <Header4 size="regular" className={classNames("mt-10", subTitle)}>
          2. Create your workflow
        </Header4>
      </div>
      <Tab.Group>
        <div className={maxWidth}>
          <UnderlinedList>
            <Underlined>Start from an example</Underlined>
            <Underlined>Start from scratch</Underlined>
          </UnderlinedList>
        </div>
        <Tab.Panels className="flex-grow pt-4">
          <Tab.Panel className="relative h-full">
            {/* Example projects tabs */}
            <Tab.Group>
              <div className="-ml-12 max-w-[59rem] overflow-hidden overflow-x-auto border-r border-slate-700 pl-12 scrollbar-hide">
                <LargeBoxList>
                  {exampleProjects.map((project) => {
                    return (
                      <LargeBox key={project.name}>
                        {project.icon}
                        <Body>{project.name}</Body>
                      </LargeBox>
                    );
                  })}
                </LargeBoxList>
              </div>
              {/* Example projects content */}
              <Tab.Panels className={classNames("flex-grow pt-4", maxWidth)}>
                {exampleProjects.map((project) => {
                  return (
                    <Tab.Panel key={project.name} className="relative h-full">
                      <div className="mb-4 mt-4 flex items-center gap-2">
                        {project.icon}
                        <Header4
                          size="small"
                          className="font-semibold text-slate-300"
                        >
                          {project.title}
                        </Header4>
                      </div>
                      <Body size="regular" className="mb-4 text-slate-400">
                        {project.description}
                      </Body>
                      <Body size="regular" className="mb-2 text-slate-400">
                        Install these additional API integration packages:
                      </Body>
                      <InstallPackages packages={project.requiredPackages} />
                      <Body size="regular" className="mb-2 mt-4 text-slate-400">
                        Copy this example code into your project. Your API key
                        has already been inserted.
                      </Body>
                      <CodeBlock
                        code={project.code(environment.apiKey)}
                        align="top"
                      />

                      <Header4
                        size="regular"
                        className={classNames(subTitle, "mt-8")}
                      >
                        3. Run your web server
                      </Header4>
                      <Body size="regular" className="mb-4 text-slate-400">
                        Run your server how you normally would, e.g.{" "}
                        <InlineCode>npm run dev</InlineCode>. This will connect
                        your workflow to Trigger.dev, so we can start sending
                        you events. You should see some log messages in your
                        server console (tip: you can turn these off by removing
                        the <InlineCode>logLevel: "info"</InlineCode> from the
                        code above).
                      </Body>
                      <CheckForWorkflows />
                    </Tab.Panel>
                  );
                })}
              </Tab.Panels>
            </Tab.Group>
          </Tab.Panel>
          <Tab.Panel className="relative h-full">
            <Tab.Group>
              {/* From scratch projects titles */}
              <div className="-ml-12 max-w-[59rem] overflow-hidden overflow-x-auto pl-12">
                <LargeBoxList>
                  {fromScratchProjects.map((project) => {
                    return (
                      <LargeBox key={project.name}>{project.name}</LargeBox>
                    );
                  })}
                </LargeBoxList>
              </div>
              {/* From scratch projects content */}
              <Tab.Panels className={classNames("flex-grow pt-4", maxWidth)}>
                {fromScratchProjects.map((project) => {
                  return (
                    <Tab.Panel key={project.name} className="relative h-full">
                      <Body size="regular" className="mb-4 text-slate-400">
                        {project.description}
                      </Body>
                      <Body size="regular" className="mb-2 mt-4 text-slate-400">
                        Copy this example code into your project.
                      </Body>
                      <CodeBlock
                        code={project.code(environment.apiKey)}
                        align="top"
                      />
                      <Header4
                        size="regular"
                        className={classNames(subTitle, "mt-8")}
                      >
                        3. Run your web server
                      </Header4>
                      <CheckForWorkflows />
                      <Body size="regular" className="mb-4 text-slate-400">
                        Run your server how you normally would, e.g.{" "}
                        <InlineCode>npm run dev</InlineCode>. This will connect
                        your workflow to Trigger.dev, so we can start sending
                        you events. You should see some log messages in your
                        server console (tip: you can turn these off by removing
                        the <InlineCode>logLevel: "info"</InlineCode> from the
                        code above).
                      </Body>
                    </Tab.Panel>
                  );
                })}
              </Tab.Panels>
            </Tab.Group>
          </Tab.Panel>
        </Tab.Panels>
      </Tab.Group>
    </Container>
  );
}

function CheckForWorkflows() {
  const fetchWorkflowCount = useTypedFetcher<typeof action>();

  if (fetchWorkflowCount.state !== "idle") {
    return (
      <Panel>
        <div className="mb-3 flex items-center gap-2">
          <Spinner />
          <Body size="regular" className="text-slate-300">
            Waiting for your workflow to connect...
          </Body>
        </div>
        <PrimaryButton>Connecting…</PrimaryButton>
      </Panel>
    );
  }

  if (fetchWorkflowCount.data === undefined) {
    return (
      <fetchWorkflowCount.Form method="post">
        <Panel>
          <div className="mb-3 flex items-center gap-2">
            <Spinner />
            <Body size="regular" className="text-slate-300">
              Waiting for your workflow to connect...
            </Body>
          </div>
          <PrimaryButton type="submit">
            Check my workflow connection
          </PrimaryButton>
        </Panel>
      </fetchWorkflowCount.Form>
    );
  } else {
    if (fetchWorkflowCount.data.hasNewWorkflows) {
      return (
        <div>
          <Panel>
            <div className="flex items-center gap-2">
              <CheckCircleIcon className="h-5 w-5 text-green-400" />
              <Body size="regular" className="font-semibold text-slate-300">
                Great, "{fetchWorkflowCount.data.newWorkflow?.title}" is
                connected!
                <PrimaryLink
                  to={`../workflows/${fetchWorkflowCount.data.newWorkflow?.slug}`}
                >
                  View workflow
                </PrimaryLink>
              </Body>
            </div>
          </Panel>
        </div>
      );
    } else {
      return (
        <Panel>
          <div className="mb-3 flex items-center gap-2">
            <ExclamationTriangleIcon className="h-5 w-5 text-amber-400" />
            <Body size="regular" className="text-slate-300">
              It doesn't seem like your workflow has connected yet. Check your
              server is running and try again.
            </Body>
          </div>
          <fetchWorkflowCount.Form method="post">
            <PrimaryButton type="submit">
              Check my workflow connection
            </PrimaryButton>
          </fetchWorkflowCount.Form>
        </Panel>
      );
    }
  }
}
