import {
  CloudIcon,
  CubeIcon,
  CubeTransparentIcon,
  HomeIcon,
} from "@heroicons/react/24/outline";
import classNames from "classnames";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { TertiaryLink } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { TemplateOverview } from "~/components/templates/TemplateOverview";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { StepNumber } from "../__app/orgs/$organizationSlug/__org/workflows.new";

const buttonStyles =
  "relative flex flex-col group items-center justify-start hover:bg-slate-700 px-4 shadow gap-4 rounded bg-slate-700/50 py-8 border border-slate-700 transition";
const labelStyles =
  "absolute top-0 right-0 uppercase text-xs text-slate-900 px-2 py-1 font-semibold rounded-bl rounded-tr";

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

function Step1() {
  return (
    <div className="mb-6">
      <SubTitle className="flex items-center">
        <StepNumber stepNumber="1" />
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
          <button className={buttonStyles}>
            <CloudIcon className="h-10 w-10 text-blue-400" />
            <Header3>Host the workflow for me in the cloud</Header3>
            <Body size="small" className="text-slate-400">
              Trigger.dev can host and handle the servers for me.
            </Body>
          </button>
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
          <StepNumber stepNumber="✓" />
          I'll host the workflow myself
        </SubTitle>
        <TertiaryLink to="/">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="2" />
          Would you like to start with a template?
        </SubTitle>
        <Panel className="flex w-full items-center justify-between">
          <div className="grid w-full grid-cols-2 gap-x-4">
            <button className={buttonStyles}>
              <div className={classNames("bg-green-400", labelStyles)}>
                Easy
              </div>
              <CubeIcon className="h-10 w-10 text-indigo-400" />
              <Header3>I'll start with a template</Header3>
              <Body size="small" className="text-slate-400">
                We'll setup a new GitHub repository with your template
                installed.
              </Body>
            </button>
            <button className={buttonStyles}>
              <div className={classNames("bg-rose-400", labelStyles)}>
                Advanced
              </div>
              <CubeTransparentIcon className="h-10 w-10 text-rose-500" />
              <Header3>I'll start from scratch</Header3>
              <Body size="small" className="text-slate-400">
                We'll setup a new GitHub repository but with a boilerplate
                template.
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
          <StepNumber stepNumber="3" />
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
          <StepNumber stepNumber="4" />
          You're nearly done!
        </SubTitle>
        <TemplateOverview />
      </div>
    </>
  );
}
