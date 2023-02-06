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
  TertiaryA,
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

const maxWidth = "flex max-w-4xl";
const subTitle = "text-slate-200 font-semibold mb-3";
const carousel =
  "-ml-[26px] overflow-hidden overflow-x-auto pl-[1.5rem] scrollbar-hide";

export default function NewWorkflowPage() {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be defined");
  invariant(environment, "Environment must be defined");

  return (
    <Container>
      <Title>Create a new workflow</Title>
      <div className={classNames(maxWidth)}>
        <StepNumber stepNumber="1" drawLine />
        <div className="mb-6 w-full">
          <Header4 size="regular" className={subTitle}>
            Install the Trigger.dev package
          </Header4>
          <InstallPackages packages={"@trigger.dev/sdk"} />
        </div>
      </div>
      <Tab.Group>
        <div className={classNames(maxWidth)}>
          <StepNumber stepNumber="2" drawLine />
          <div className="mb-6 w-full pr-10">
            <Header4 size="regular" className={classNames(subTitle)}>
              Create your workflow
            </Header4>
            <UnderlinedList>
              <Underlined>Start from an example</Underlined>
              <Underlined>Start from scratch</Underlined>
            </UnderlinedList>
            <Tab.Panels className="flex-grow pt-4">
              <Tab.Panel className="relative h-full">
                {/* Example projects tabs */}
                <Tab.Group>
                  <div
                    className={classNames(
                      carousel,
                      "border-r border-slate-700"
                    )}
                  >
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
                  <Tab.Panels className={classNames("flex-grow pt-4")}>
                    {exampleProjects.map((project) => {
                      return (
                        <Tab.Panel
                          key={project.name}
                          className="relative h-full"
                        >
                          <div className="">
                            <div className="mb-4 mt-4 flex items-center gap-2">
                              {project.icon}
                              <Header4
                                size="small"
                                className="font-semibold text-slate-300"
                              >
                                {project.title}
                              </Header4>
                            </div>
                            <Body
                              size="regular"
                              className="mb-4 text-slate-400"
                            >
                              {project.description}
                            </Body>
                            <Body
                              size="regular"
                              className="mb-2 text-slate-400"
                            >
                              Install these additional API integration packages:
                            </Body>
                            <InstallPackages
                              packages={project.requiredPackages}
                            />
                            <Body
                              size="regular"
                              className="mb-2 mt-4 text-slate-400"
                            >
                              Copy this example code into your project. Your API
                              key has already been inserted.
                            </Body>
                            <CodeBlock
                              code={project.code(environment.apiKey)}
                              align="top"
                            />
                          </div>
                        </Tab.Panel>
                      );
                    })}
                  </Tab.Panels>
                </Tab.Group>
              </Tab.Panel>
              <Tab.Panel className="relative h-full">
                <Tab.Group>
                  {/* From scratch projects titles */}
                  <div className={classNames(carousel)}>
                    <LargeBoxList>
                      {fromScratchProjects.map((project) => {
                        return (
                          <LargeBox key={project.name}>{project.name}</LargeBox>
                        );
                      })}
                    </LargeBoxList>
                  </div>
                  {/* From scratch projects content */}
                  <Tab.Panels className={classNames("flex-grow pt-4")}>
                    {fromScratchProjects.map((project) => {
                      return (
                        <Tab.Panel
                          key={project.name}
                          className="relative h-full"
                        >
                          <div className="">
                            <Body
                              size="regular"
                              className="mb-4 text-slate-400"
                            >
                              {project.description}
                            </Body>
                            <ul className="ml-[17px] list-disc text-slate-400 marker:text-indigo-400">
                              {project.bulletPoint1 ? (
                                <li>{project.bulletPoint1}</li>
                              ) : (
                                ""
                              )}
                              {project.bulletPoint2 ? (
                                <li>{project.bulletPoint2}</li>
                              ) : (
                                ""
                              )}
                              {project.bulletPoint3 ? (
                                <li>{project.bulletPoint3}</li>
                              ) : (
                                ""
                              )}
                            </ul>
                            <Body
                              size="regular"
                              className="mb-2 mt-4 text-slate-400"
                            >
                              Use this example code in your project to get
                              started. Or learn more about {project.name}s in
                              the{" "}
                              <TertiaryA
                                href={project.docsLink}
                                target={"_blank"}
                                className="!text-base text-slate-400 underline decoration-green-500 underline-offset-2 hover:text-white hover:decoration-green-400"
                              >
                                docs
                              </TertiaryA>
                              .
                            </Body>
                            <CodeBlock
                              code={project.code(environment.apiKey)}
                              align="top"
                            />
                          </div>
                        </Tab.Panel>
                      );
                    })}
                  </Tab.Panels>
                </Tab.Group>
              </Tab.Panel>
            </Tab.Panels>
          </div>
        </div>
      </Tab.Group>
      <div className={classNames(maxWidth)}>
        <StepNumber stepNumber="3" />
        <div className="w-full">
          <Header4 size="regular" className={subTitle}>
            Run your web server
          </Header4>
          <Body size="regular" className="mb-4 text-slate-400">
            Run your server as you typically do, e.g.{" "}
            <InlineCode>npm run dev</InlineCode>. This will connect your
            workflow to Trigger.dev, so we can start sending you events. You
            should see some log messages in your server console (tip: you can
            turn these off by removing the{" "}
            <InlineCode>logLevel: "info"</InlineCode> from the code above).
          </Body>
          <CheckForWorkflows />
        </div>
      </div>
    </Container>
  );
}

function StepNumber({
  stepNumber,
  drawLine,
}: {
  stepNumber: string;
  drawLine?: boolean;
}) {
  return (
    <div className="mr-3 flex flex-col items-center justify-center">
      <span className="flex h-7 w-7 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-sm text-green-400 shadow">
        {stepNumber}
      </span>
      {drawLine ? (
        <div className="h-full border-l border-slate-700"></div>
      ) : (
        <div className="h-full"></div>
      )}
    </div>
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
              Waiting for your workflow to connect…
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
              </Body>
            </div>
            <PrimaryLink
              to={`../workflows/${fetchWorkflowCount.data.newWorkflow?.slug}`}
            >
              View workflow
            </PrimaryLink>
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
