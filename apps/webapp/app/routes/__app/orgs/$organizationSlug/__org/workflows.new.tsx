import { Tab } from "@headlessui/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import CodeBlock from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { InstallPackages } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { TertiaryLink } from "~/components/primitives/Buttons";
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
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);

  const providers = getIntegrationMetadatas(false);

  return typedjson({ providers });
};

const maxWidth = "max-w-4xl";
const subTitle = "text-slate-200 font-semibold mb-4";

export default function NewWorkflowPage() {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  if (currentOrganization === undefined) {
    return <></>;
  }
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
              <div className="-ml-12 max-w-[59rem] overflow-hidden overflow-x-auto  border-r border-slate-700 pl-12">
                <LargeBoxList>
                  {exampleProjects.map((project) => {
                    return (
                      <>
                        <LargeBox key={project.name}>
                          {project.icon}
                          <Body>{project.name}</Body>
                        </LargeBox>
                      </>
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
