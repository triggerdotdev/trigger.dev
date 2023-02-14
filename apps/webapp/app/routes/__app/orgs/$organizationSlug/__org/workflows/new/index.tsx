import {
  CloudIcon,
  HomeIcon,
  RocketLaunchIcon,
  SunIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Fragment, useState } from "react";
import { Panel } from "~/components/layout/Panel";
import { onboarding } from "~/components/onboarding/classNames";
import { StepNumber } from "~/components/onboarding/StepNumber";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { StyledDialog } from "~/components/primitives/Dialog";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";

export default function NewWorkflowStep1Page() {
  return <Step1 />;
}

function Step1() {
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
            <StyledDialog.Panel className="mx-auto flex max-w-3xl items-start gap-2 overflow-hidden">
              <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-slate-800 text-left">
                <div className="relative flex flex-col items-center justify-between gap-5 overflow-hidden border-b border-slate-850/80 bg-blue-400 px-4 py-12">
                  <CloudIcon className="absolute top-2 -left-4 h-28 w-28 animate-pulse text-white" />
                  <CloudIcon className="absolute top-16 right-16 h-16 w-16 animate-pulse text-white" />
                  <SunIcon className="absolute -top-12 -right-12 h-32 w-32 text-yellow-400" />
                  <RocketLaunchIcon className="h-20 w-20 animate-[float_3s_ease-in-out_infinite] text-slate-800" />
                  <Header3>Cloud hosting coming soon…</Header3>
                </div>
                <div className="p-6">
                  <Body size="small" className="text-center text-slate-400">
                    We're working hard to bring you a cloud hosted service.
                  </Body>
                  <PrimaryButton
                    onClick={() => setIsOpen(false)}
                    className="mt-2 w-full"
                  >
                    Got it
                  </PrimaryButton>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="sticky top-0 text-slate-600 transition hover:text-slate-500"
              >
                <XCircleIcon className="h-10 w-10" />
              </button>
            </StyledDialog.Panel>
          </div>
        </div>
      </StyledDialog.Dialog>
      <div className={classNames(onboarding.maxWidth, "mb-6")}>
        <SubTitle className="flex items-center">
          <StepNumber active stepNumber="1" />
          Where do you want your workflow hosted?
        </SubTitle>
        <Panel className="flex w-full items-center justify-between">
          <div className="grid w-full grid-cols-2 gap-x-4">
            <Link to="step2" className={onboarding.buttonStyles}>
              <HomeIcon className="h-10 w-10 text-green-400" />
              <Header3>I'll host the workflow myself</Header3>
              <Body size="small" className="text-slate-400">
                I will deploy the code to my own servers.
              </Body>
            </Link>
            <button
              type="button"
              onClick={(e) => setIsOpen(true)}
              className={onboarding.buttonStyles}
            >
              <CloudIcon className="h-10 w-10 text-blue-400" />
              <Header3>Host the workflow for me in the cloud</Header3>
              <Body size="small" className="text-slate-400">
                Trigger.dev can host and handle the servers for me.
              </Body>
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}
