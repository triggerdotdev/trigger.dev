import {
  CloudIcon,
  CubeIcon,
  CubeTransparentIcon,
  HomeIcon,
  RocketLaunchIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { useState } from "react";
import { InstallPackages } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import {
  PrimaryLink,
  TertiaryA,
  TertiaryLink,
} from "~/components/primitives/Buttons";
import { LargeBox, LargeBoxList } from "~/components/primitives/Tabs";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { TemplateOverview } from "~/components/templates/TemplateOverview";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { StepNumber } from "../__app/orgs/$organizationSlug/__org/workflows.new";
import {
  exampleProjects,
  fromScratchProjects,
} from "~/components/samples/samplesList";
import { Tab } from "@headlessui/react";
import CodeBlock from "~/components/code/CodeBlock";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import invariant from "tiny-invariant";

export default function TemplatesLayout() {
  return (
    <Container className="mx-auto flex w-full max-w-5xl flex-col">
      <Header1 className="mb-6">Get started</Header1>
      {/* <Step1 /> */}
      {/* <Step2 /> */}
      {/* <Step3NewRepo1 /> */}
      {/* <Step3NewRepo2 /> */}
      {/* <Step3ExistingRepo1 /> */}
      <Step3ExistingRepo2 />
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
    <div className="mb-6">
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
    <>
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
                Recommended
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
                Use an existing repo.
              </Body>
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}

function Step3NewRepo1() {
  return (
    <>
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
    </>
  );
}

function Step3NewRepo2() {
  return (
    <>
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
            The template i've chosen is: GitHub Issue to Slack
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="4" />
          You're nearly done!
        </SubTitle>
        <TemplateOverview />
      </div>
    </>
  );
}

function Step3ExistingRepo1() {
  return (
    <>
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
            I'll host the repo myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="3" />
          Install the Trigger.dev package
        </SubTitle>
        <Panel className="flex flex-col gap-3">
          <InstallPackages packages={"@trigger.dev/sdk"} />
          <PrimaryLink to="#">Continue</PrimaryLink>
        </Panel>
      </div>
    </>
  );
}

function Step3ExistingRepo2() {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be defined");
  invariant(environment, "Environment must be defined");
  return (
    <>
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
            I'll host the repo myself
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber />
          <Link to="#" className="transition hover:text-slate-300">
            I've installed the Trigger.dev package
          </Link>
        </SubTitle>
        <TertiaryLink to="#">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="4" />
          Choose an example or start from scratch
        </SubTitle>
        <TemplatesGrid />
        <Body className="my-4">Start your workflow from scratch</Body>
        <Tab.Panel className="relative h-full">
          <Tab.Group>
            {/* From scratch projects titles */}
            <div className={classNames(carousel)}>
              <LargeBoxList>
                {fromScratchProjects.map((project) => {
                  return <LargeBox key={project.name}>{project.name}</LargeBox>;
                })}
              </LargeBoxList>
            </div>
            {/* From scratch projects content */}
            <Tab.Panels className={classNames("flex-grow pt-4")}>
              {fromScratchProjects.map((project) => {
                return (
                  <Tab.Panel key={project.name} className="relative h-full">
                    <div className="">
                      <Body size="regular" className="mb-4 text-slate-400">
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
                      <Body size="regular" className="mb-2 mt-4 text-slate-400">
                        Use this example code in your project to get started. Or
                        learn more about {project.name}s in the{" "}
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
      </div>
    </>
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

const buttonStyles =
  "relative flex flex-col items-center justify-start hover:bg-slate-700 px-4 shadow gap-4 rounded bg-slate-700/50 py-8 border border-slate-700 transition";
const labelStyles =
  "absolute top-0 right-0 uppercase text-xs text-slate-900 px-2 py-1 font-semibold rounded-bl rounded-tr";
const carousel = "-ml-[26px] overflow-hidden overflow-x-auto pl-[1.5rem]";
