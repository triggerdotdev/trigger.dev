import { Dialog, Transition } from "@headlessui/react";
import {
  CheckCircleIcon,
  CloudIcon,
  CubeIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
  HomeIcon,
  RocketLaunchIcon,
} from "@heroicons/react/24/outline";
import { XCircleIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import classNames from "classnames";
import { Fragment, useState } from "react";
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
import { StyledDialog } from "~/components/primitives/Dialog";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import {
  exampleProjects,
  fromScratchProjects,
} from "~/components/samples/samplesList";
import { TemplateOverview } from "~/components/templates/TemplateOverview";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
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

export default function NewWorkflowPage() {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be defined");
  invariant(environment, "Environment must be defined");

  return (
    <Container>
      <Title>Create a new workflow</Title>
      {/* <Step1 /> */}
      {/* <Step2 /> */}
      {/* <Step3NewRepo1 /> */}
      {/* <Step3NewRepo2 /> */}
      <Step3ExistingRepo2 />
      {/* <Step3ExistingRepo3 /> */}
      {/* <Step3ExistingRepo4 /> */}
      {/* <Step3ExistingRepo5 /> */}
      {/* <Step3ExistingRepo6 /> */}
    </Container>
  );
}

type Step1Props = {
  showVisitedButtonState: () => void;
};

function Step1() {
  const [buttonVisited, setbuttonVisited] = useState(true);

  function showVisitedButtonState() {
    setbuttonVisited(!buttonVisited);
  }

  return (
    <div className={classNames(maxWidth, "mb-6")}>
      <SubTitle className="flex items-center">
        <StepNumber active stepNumber="1" />
        Where do you want your workflow hosted?
      </SubTitle>
      <Panel className="flex w-full items-center justify-between">
        <div className="grid w-full grid-cols-2 gap-x-4">
          <button className={buttonStyles}>
            <HomeIcon className="h-10 w-10 text-green-400" />
            <Header3>I'll host the workflow myself</Header3>
            <Body size="small" className="text-slate-400">
              I will deploy the code to my own servers.
            </Body>
          </button>
          {buttonVisited ? (
            <Step1Hosted showVisitedButtonState={showVisitedButtonState} />
          ) : (
            <Step1HostedVisited />
          )}
        </div>
      </Panel>
    </div>
  );
}

function Step2() {
  return (
    <div className={classNames(maxWidth, "flex flex-col")}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="2" />
          Would you like to create a new GitHub repository?
        </SubTitle>
        <Panel className="flex w-full items-center justify-between">
          <div className="grid w-full grid-cols-2 gap-x-4">
            <button className={buttonStyles}>
              <div className={classNames("bg-green-400", labelStyles)}>
                Easy (2 mins)
              </div>
              <CubeTransparentIcon className="h-10 w-10 text-indigo-400" />
              <Header3>I want to create a new repo</Header3>
              <Body size="small" className="text-slate-400">
                We'll setup a new GitHub repository and install your template.
              </Body>
            </button>
            <button className={buttonStyles}>
              <CubeIcon className="h-10 w-10 text-orange-400" />
              <Header3>I want to use an existing repo</Header3>
              <Body size="small" className="text-slate-400">
                I want my workflow to be alongside my existing code.
              </Body>
            </button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Step3NewRepo1() {
  return (
    <div className={classNames(maxWidth)}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll start with a template
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="3" />
          Which template would you like to use?
        </SubTitle>
        <TemplatesGrid />
      </div>
    </div>
  );
}

function Step3NewRepo2() {
  return (
    <div className={classNames(maxWidth)}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll start with a template
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I chose the {exampleProjects[0].name} template
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="4" />
          Confirm your chosen template
        </SubTitle>
        <Panel className="px-4 py-4">
          <TemplateOverview />
        </Panel>
      </div>
    </div>
  );
}

function Step3ExistingRepo2() {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be defined");
  invariant(environment, "Environment must be defined");
  let [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <StyledDialog.Dialog
        onClose={(e) => setIsOpen(false)}
        appear
        show={isOpen}
        as={Fragment}
      >
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <StyledDialog.Panel className="relative mx-auto w-96 min-w-[1000px] max-w-5xl rounded bg-white">
              <button
                onClick={() => setIsOpen(false)}
                className="absolute top-0 -right-12 text-slate-600 transition hover:text-slate-500"
              >
                <XCircleIcon className="h-10 w-10" />
              </button>
              <TemplateOverview />
            </StyledDialog.Panel>
          </div>
        </div>
      </StyledDialog.Dialog>
      <div className={classNames("flex flex-col", maxWidth)}>
        <div className="flex items-center justify-between">
          <SubTitle className="flex items-center">
            <StepNumber />
            <Link to="#" className="transition hover:text-slate-300">
              I'll host the workflow myself
            </Link>
          </SubTitle>
          <TertiaryLink to="#">Change answer</TertiaryLink>
        </div>
        <div className="flex items-center justify-between">
          <SubTitle className="flex items-center">
            <StepNumber />
            <Link to="#" className="transition hover:text-slate-300">
              I'll use an existing repo
            </Link>
          </SubTitle>
          <TertiaryLink to="#">Change answer</TertiaryLink>
        </div>
        <div className="mb-6">
          <SubTitle className="flex items-center">
            <StepNumber active stepNumber="3" />
            Choose an example
          </SubTitle>
          <Panel className="px-4 py-4">
            <SubTitle>
              Browse examples to use as a starting point. (Opens in a modal)
            </SubTitle>
            <div className="grid grid-cols-4 gap-2">
              <div className={buttonStyles}>
                <CubeTransparentIcon className="h-8 w-8 text-slate-400" />
                <Body>Blank example</Body>
              </div>
              {exampleProjects.map((project) => {
                return (
                  <button
                    key={project.name}
                    type="button"
                    onClick={(e) => setIsOpen(true)}
                    className={buttonStyles}
                  >
                    {project.icon}
                    <Body>{project.name}</Body>
                  </button>
                );
              })}
            </div>
            <SubTitle className="mt-6">Or start from scratch</SubTitle>
            <div className="grid grid-cols-4 gap-2">
              {fromScratchProjects.map((project) => {
                return (
                  <div key={project.name} className={buttonStyles}>
                    {project.name}
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Step3ExistingRepo3() {
  return (
    <div className={maxWidth}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll use an existing repo
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've chosen the template: GitHub Issue to Slack
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div>
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="4" />
          Install the Trigger.dev packages for this example
        </SubTitle>
      </div>
      <Panel className="px-4 py-4">
        <InstallPackages packages={exampleProjects[0].requiredPackages} />
        <PrimaryLink className="mt-2" to="#">
          Continue
        </PrimaryLink>
      </Panel>
    </div>
  );
}

function Step3ExistingRepo4() {
  const environment = useCurrentEnvironment();
  invariant(environment, "Environment must be defined");
  return (
    <div className={maxWidth}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll use an existing repo
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've chosen the template: GitHub Issue to Slack
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've installed the packages
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <SubTitle className="flex items-center">
        <StepNumber active stepNumber="5" />
        Copy the example code into your project
      </SubTitle>
      <Panel className="px-4 py-4">
        <Body size="regular" className="mb-2 text-slate-400">
          Your API key has already been inserted.
        </Body>
        <CodeBlock
          code={exampleProjects[0].code(environment.apiKey)}
          align="top"
        />
        <PrimaryLink className="mt-2" to="#">
          Continue
        </PrimaryLink>
      </Panel>
    </div>
  );
}

function Step3ExistingRepo5() {
  return (
    <div className={maxWidth}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll use an existing repo
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've chosen the template: GitHub Issue to Slack
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've installed the packages
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've added the example code to my project
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <SubTitle className="flex items-center">
        <StepNumber active stepNumber="6" />
        Check your workflow file is running
      </SubTitle>
      <Panel className="px-4 py-4">
        <Body size="regular" className="mb-4 text-slate-400">
          Ensure that your workflow file is run.
        </Body>
        <PrimaryLink to="#">Continue</PrimaryLink>
      </Panel>
    </div>
  );
}

function Step3ExistingRepo6() {
  return (
    <div className={maxWidth}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I'll use an existing repo
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've chosen the template: GitHub Issue to Slack
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've installed the packages
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've added the example code to my project
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            My workflow file is running
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <SubTitle className="flex items-center">
        <StepNumber active stepNumber="7" />
        Lastly, run your web server
      </SubTitle>
      <Panel className="px-4 py-4">
        <Body size="regular" className="mb-4 text-slate-400">
          Run your server as you typically do, e.g.{" "}
          <InlineCode>npm run dev</InlineCode>. This will connect your workflow
          to Trigger.dev, so we can start sending you events. You should see
          some log messages in your server console (tip: you can turn these off
          by removing the <InlineCode>logLevel: "info"</InlineCode> from the
          code above).
        </Body>
        <CheckForWorkflows />
      </Panel>
    </div>
  );
}

function Step1Hosted({ showVisitedButtonState }: Step1Props) {
  return (
    <button onClick={showVisitedButtonState} className={buttonStyles}>
      <CloudIcon className="h-10 w-10 text-blue-400" />
      <Header3>Host the workflow for me in the cloud</Header3>
      <Body size="small" className="text-slate-400">
        Trigger.dev can host and handle the servers for me.
      </Body>
    </button>
  );
}

function Step1HostedVisited() {
  return (
    <div className="relative flex flex-col items-center justify-start gap-4 rounded border border-dashed border-slate-950 bg-slate-800 px-4 py-8 transition">
      <RocketLaunchIcon className="h-10 w-10 animate-pulse text-blue-400" />
      <Header3>Cloud hosting coming soon…</Header3>
      <Body size="small" className="text-center text-slate-400">
        We're working hard to bring you a cloud hosted service.
      </Body>
    </div>
  );
}

function CheckForWorkflows() {
  const fetchWorkflowCount = useTypedFetcher<typeof action>();

  if (fetchWorkflowCount.state !== "idle") {
    return (
      <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
        <div className="mb-3 flex items-center gap-2">
          <Spinner />
          <Body size="regular" className="text-slate-300">
            Waiting for your workflow to connect...
          </Body>
        </div>
        <PrimaryButton>Connecting…</PrimaryButton>
      </div>
    );
  }

  if (fetchWorkflowCount.data === undefined) {
    return (
      <fetchWorkflowCount.Form method="post">
        <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
          <div className="flex items-center gap-2">
            <Spinner />
            <Body size="regular" className="text-slate-300">
              Waiting for your workflow to connect…
            </Body>
          </div>
          <PrimaryButton type="submit">
            Check my workflow connection
          </PrimaryButton>
        </div>
      </fetchWorkflowCount.Form>
    );
  } else {
    if (fetchWorkflowCount.data.hasNewWorkflows) {
      return (
        <div>
          <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
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
          </div>
        </div>
      );
    } else {
      return (
        <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
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
        </div>
      );
    }
  }
}

export function StepNumber({
  stepNumber,
  drawLine,
  active = false,
}: {
  stepNumber?: string;
  drawLine?: boolean;
  active?: boolean;
}) {
  return (
    <div className="mr-3 flex flex-col items-center justify-center">
      {active ? (
        <span className="flex h-7 w-7 items-center justify-center rounded bg-green-600 py-1 text-sm font-semibold text-slate-900 shadow">
          {stepNumber}
        </span>
      ) : (
        <span className="flex h-7 w-7 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-sm font-semibold text-green-400 shadow">
          ✓
        </span>
      )}

      {drawLine ? (
        <div className="h-full border-l border-slate-700"></div>
      ) : (
        <div className="h-full"></div>
      )}
    </div>
  );
}

const buttonStyles =
  "relative flex flex-col cursor-pointer items-center justify-start hover:bg-slate-700 px-4 shadow gap-4 rounded bg-slate-700/50 py-8 border border-slate-700 transition";
const labelStyles =
  "absolute top-0 right-0 uppercase text-xs text-slate-900 px-2 py-1 font-semibold rounded-bl rounded-tr";
const maxWidth = "flex flex-col max-w-4xl";
