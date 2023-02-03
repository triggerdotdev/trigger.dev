import { Tab } from "@headlessui/react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Underlined, UnderlinedList } from "~/components/primitives/Tabs";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import CodeBlock from "./code/CodeBlock";
import { PrimaryLink, SecondaryA } from "./primitives/Buttons";
import { SubTitle } from "./primitives/text/SubTitle";

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

export function InstallPackages({ packages }: { packages: string }) {
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
