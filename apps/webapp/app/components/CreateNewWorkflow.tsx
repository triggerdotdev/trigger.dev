import { Tab } from "@headlessui/react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";
import classNames from "classnames";
import type { ReactNode } from "react";
import invariant from "tiny-invariant";
import {
  LargeBox,
  LargeBoxList,
  Underlined,
  UnderlinedList,
} from "~/components/StyledTabs";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import CodeBlock from "./code/CodeBlock";
import { PrimaryLink, SecondaryA, TertiaryLink } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { Header4 } from "./primitives/text/Headers";
import { SubTitle } from "./primitives/text/SubTitle";
import { exampleProjects, fromScratchProjects } from "./samples/samplesList";

export function CreateNewWorkflow() {
  const currentOrganization = useCurrentOrganization();
  if (currentOrganization === undefined) {
    return <></>;
  }
  return (
    <>
      <SubTitle>Create a new workflow</SubTitle>
      <div className="flex gap-2">
        <PrimaryLink
          to={`/orgs/${currentOrganization.slug}/workflows/new`}
          rel="noreferrer"
        >
          Create a workflow
        </PrimaryLink>
        <SecondaryA
          href="https://docs.trigger.dev"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          <span>Documentation</span>
        </SecondaryA>
      </div>
    </>
  );
}

export function CreateNewWorkflowNoWorkflows({
  providers,
}: {
  providers: IntegrationMetadata[];
}) {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  if (currentOrganization === undefined) {
    return <></>;
  }
  invariant(environment, "Environment must be defined");
  return (
    <div className="max-w-4xl">
      <Header4 size="regular" className={subTitle}>
        1. Install the Trigger.dev package
      </Header4>
      <InstallPackages packages={"@trigger.dev/sdk"} />
      <Header4 size="regular" className={classNames("mt-10", subTitle)}>
        2. Create your workflow
      </Header4>
      <Tab.Group>
        <UnderlinedList>
          <Underlined>Start from an example</Underlined>
          <Underlined>Start from scratch</Underlined>
        </UnderlinedList>
        <Tab.Panels className="flex-grow pt-4">
          <Tab.Panel className="relative h-full">
            {/* Example projects tabs */}
            <Tab.Group>
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
              {/* Example projects content */}
              <Tab.Panels className="flex-grow pt-4">
                {exampleProjects.map((project) => {
                  return (
                    <Tab.Panel key={project.name} className="relative h-full">
                      <div className="mb-4 flex items-center gap-2">
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
                        Install these extra API integration packages:
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
                      <Header4
                        size="regular"
                        className={classNames(subTitle, "mt-8")}
                      >
                        4. Test your workflow from the dashboard
                      </Header4>
                      <Body size="regular" className="mb-4 text-slate-400">
                        On the{" "}
                        <TertiaryLink
                          to={`/orgs/${currentOrganization.slug}`}
                          className="!text-base text-slate-400 underline decoration-green-500 underline-offset-2 transition hover:decoration-[3px]"
                        >
                          Organization page
                        </TertiaryLink>{" "}
                        you should see that the Workflow has now appeared (you
                        may need to refresh the page since running your server
                        in the previous step).
                      </Body>
                      <Body size="regular" className="mb-4 text-slate-400">
                        The workflow is connected to Trigger.dev so the next
                        step is to trigger it. You can easily test your workflow
                        by clicking on it from the Workflows page and selecting
                        the Test tab in the side menu.
                      </Body>

                      <Body size="regular" className="mb-4 text-slate-400">
                        In the test field, input a valid test event. You can
                        copy this example:
                      </Body>
                      <CodeBlock
                        code="test code"
                        align="top"
                        language="json"
                        className="mb-4"
                      />
                      <Body size="regular" className="mb-4 text-slate-400">
                        Hit the “Run test” button and it will take you to the
                        run. Refresh the page to see it move between steps.
                      </Body>
                    </Tab.Panel>
                  );
                })}
              </Tab.Panels>
            </Tab.Group>
          </Tab.Panel>
          <Tab.Panel className="relative h-full">
            <Tab.Group>
              {/* From scratch projects titles */}
              <LargeBoxList>
                {fromScratchProjects.map((project) => {
                  return <LargeBox key={project.name}>{project.name}</LargeBox>;
                })}
              </LargeBoxList>
              {/* From scratch projects content */}
              <Tab.Panels className="flex-grow pt-4">
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
    </div>
  );
}

const subTitle = "text-slate-200 font-semibold mb-4";
const inlineCode =
  "px-1 py-0.5 text-sm bg-slate-700 border border-slate-900 rounded text-slate-200";

function InlineCode({ children }: { children: ReactNode }) {
  return <code className={inlineCode}>{children}</code>;
}
function InstallPackages({ packages }: { packages: string }) {
  return (
    <Tab.Group>
      <UnderlinedList>
        <Underlined>npm</Underlined>
        <Underlined>pnpm</Underlined>
        <Underlined>yarn</Underlined>
      </UnderlinedList>
      <Tab.Panels className="flex-grow">
        <Tab.Panel className="relative h-full">
          <CodeBlock
            code={`npm install ${packages}`}
            language="bash"
            align="top"
            showLineNumbers={false}
          />
        </Tab.Panel>
        <Tab.Panel className="relative h-full">
          <CodeBlock
            code={`pnpm install ${packages}`}
            language="bash"
            align="top"
            showLineNumbers={false}
          />
        </Tab.Panel>
        <Tab.Panel className="relative h-full">
          <CodeBlock
            code={`yarn add ${packages}`}
            language="bash"
            align="top"
            showLineNumbers={false}
          />
        </Tab.Panel>
      </Tab.Panels>
    </Tab.Group>
  );
}
