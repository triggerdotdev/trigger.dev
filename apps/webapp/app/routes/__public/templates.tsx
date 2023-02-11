import {
  CloudIcon,
  CubeIcon,
  CubeTransparentIcon,
  EllipsisHorizontalCircleIcon,
  EllipsisHorizontalIcon,
  HomeIcon,
  MinusCircleIcon,
  MinusIcon,
  RocketLaunchIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import classNames from "classnames";
import { useState } from "react";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { TertiaryLink } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { TemplateOverview } from "~/components/templates/TemplateOverview";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { StepNumber } from "../__app/orgs/$organizationSlug/__org/workflows.new";

export default function TemplatesLayout() {
  return (
    <Container className="mx-auto flex w-full max-w-5xl flex-col">
      <Header1 className="mb-6">Get started</Header1>
      <Step1 />
      <Step2 />
      <Step3 />
      <Step4 />
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
          I'll host the workflow myself
        </SubTitle>
        <TertiaryLink to="/">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="2" />
          Would you like to create a new GitHub repository?
        </SubTitle>
        <Panel className="flex w-full items-center justify-between">
          <div className="grid w-full grid-cols-2 gap-x-4">
            <button className={buttonStyles}>
              {/* <div className={classNames("bg-green-400", labelStyles)}>
                Easy
              </div> */}
              <CubeTransparentIcon className="h-10 w-10 text-indigo-400" />
              <Header3>I want to create a new repo</Header3>
              <Body size="small" className="text-slate-400">
                We'll setup a new GitHub repository and install your template.
              </Body>
            </button>
            <button className={buttonStyles}>
              {/* <div className={classNames("bg-rose-400", labelStyles)}>
                Advanced
              </div> */}
              <CubeIcon className="h-10 w-10 text-amber-400" />
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

function Step3() {
  return (
    <>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="✓" />
          I'll host the workflow myself
        </SubTitle>
        <TertiaryLink to="/">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="✓" />
          I'll start with a template
        </SubTitle>
        <TertiaryLink to="/">Change answer</TertiaryLink>
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

function Step4() {
  return (
    <>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="✓" />
          I'll host the workflow myself
        </SubTitle>
        <TertiaryLink to="/">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="✓" />
          I'll start with a template
        </SubTitle>
        <TertiaryLink to="/">Change answer</TertiaryLink>
      </div>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="✓" />
          The template i've chosen is: GitHub Issue to Slack
        </SubTitle>
        <TertiaryLink to="/">Change answer</TertiaryLink>
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
