import CheckIcon from "@heroicons/react/20/solid/CheckIcon";
import {
  CloudIcon,
  HomeIcon,
  RocketLaunchIcon,
} from "@heroicons/react/24/outline";
import XCircleIcon from "@heroicons/react/24/solid/XCircleIcon";
import { Link, useFetcher } from "@remix-run/react";
import classNames from "classnames";
import { Fragment, useEffect, useState } from "react";
import { Panel } from "~/components/layout/Panel";
import { onboarding } from "~/components/onboarding/classNames";
import { StepNumber } from "~/components/onboarding/StepNumber";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { StyledDialog } from "~/components/primitives/Dialog";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { useUser } from "~/hooks/useUser";

export default function NewWorkflowStep1Page() {
  return <Step1 />;
}

function Step1() {
  const user = useUser();
  const fetcher = useFetcher();
  let [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (fetcher.state === "submitting") {
      setIsOpen(false);
    }
  }, [fetcher.state, setIsOpen]);

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
            <StyledDialog.Panel className="mx-auto flex max-w-xl items-start gap-2 overflow-hidden">
              <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-slate-800 text-left">
                <div className="relative flex flex-col items-center justify-between gap-5 overflow-hidden border-b border-slate-850/80 bg-blue-400 px-4 py-12">
                  <CloudIcon className="absolute top-2 -left-4 h-28 w-28 animate-pulse text-white/70" />
                  <CloudIcon className="absolute top-16 right-16 h-16 w-16 animate-pulse text-white/70" />
                  <RocketLaunchIcon className="h-20 w-20 animate-[float_3s_ease-in-out_infinite] text-slate-800" />
                  <Header3 className="font-semibold">
                    Cloud hosting coming soon…
                  </Header3>
                </div>
                <div className="p-6">
                  <Body className="mb-4 text-slate-400">
                    We're preparing to launch a cloud hosting service for your
                    Trigger.dev workflows that will make it as easy to deploy
                    your workflows as a git push.
                  </Body>
                  <div className="flex w-full justify-end">
                    <fetcher.Form
                      action="/resources/cloud-waitlist"
                      method="post"
                    >
                      {user.isOnCloudWaitlist ? (
                        <PrimaryButton
                          type="submit"
                          className="mt-2 w-full"
                          disabled
                        >
                          <CheckIcon className="-m-1 h-4 w-4 text-green-500" />
                          Already on the waitlist
                        </PrimaryButton>
                      ) : (
                        <PrimaryButton type="submit" className="mt-2 w-full">
                          Notify me when it's ready
                        </PrimaryButton>
                      )}
                    </fetcher.Form>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="sticky top-0 text-slate-300 transition hover:text-slate-200"
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
