import { CubeIcon, CubeTransparentIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Panel } from "~/components/layout/Panel";
import { onboarding } from "~/components/onboarding/classNames";
import { StepNumber } from "~/components/onboarding/StepNumber";
import { TertiaryLink } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";

export default function NewWorkflowStep2Page() {
  return <Step2 />;
}

function Step2() {
  return (
    <div className={classNames(onboarding.maxWidth, "flex flex-col")}>
      <div className="flex items-center justify-between">
        <SubTitle className="flex items-center">
          <StepNumber complete />
          <Link to=".." className="transition hover:text-slate-300">
            I'll host the workflow myself
          </Link>
        </SubTitle>
        <TertiaryLink to="..">Change answer</TertiaryLink>
      </div>
      <div className="mb-6">
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="2" />
          Would you like to create a new GitHub repository?
        </SubTitle>
        <Panel className="flex w-full items-center justify-between">
          <div className="grid w-full grid-cols-2 gap-x-4">
            <Link to="../newRepo" className={onboarding.buttonStyles}>
              <div
                className={classNames("bg-green-400", onboarding.labelStyles)}
              >
                Easy (2 mins)
              </div>
              <CubeTransparentIcon className="h-10 w-10 text-indigo-400" />
              <Header3>I want to create a new repo</Header3>
              <Body size="small" className="text-slate-400">
                We'll setup a new GitHub repository and install your template.
              </Body>
            </Link>
            <Link to="../existingRepo" className={onboarding.buttonStyles}>
              <CubeIcon className="h-10 w-10 text-orange-400" />
              <Header3>I want to use an existing repo</Header3>
              <Body size="small" className="text-slate-400">
                I want my workflow to be alongside my existing code.
              </Body>
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
