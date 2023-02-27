import { InformationCircleIcon } from "@heroicons/react/20/solid";
import {
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Fragment, useState } from "react";
import type { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { CopyTextPanel } from "../CopyTextButton";
import { PrimaryA, TertiaryButton } from "../primitives/Buttons";
import { StyledDialog } from "../primitives/Dialog";
import { Body } from "../primitives/text/Body";
import { Header4 } from "../primitives/text/Headers";
import { SubTitle } from "../primitives/text/SubTitle";
import { TemplatesGrid } from "../templates/TemplatesGrid";

export function WorkflowOnboarding({
  apiKey,
  templates,
}: {
  apiKey: string;
  templates: TemplateListItem[];
}) {
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
          <div className="flex min-h-full items-center justify-center">
            <StyledDialog.Panel className="mx-auto flex max-w-2xl flex-col justify-center overflow-hidden rounded-md border border-slate-700 bg-slate-850 text-left">
              <div className="flex w-full items-center justify-between py-3 pr-3 pl-5">
                <div className="flex w-full items-center gap-2">
                  <Header4 size="small" className="text-slate-300">
                    Setup Trigger.dev manually
                  </Header4>
                </div>
                <button
                  onClick={(e) => setIsOpen(false)}
                  className="group rounded p-1 text-slate-600 transition hover:bg-slate-700 hover:text-slate-500"
                >
                  <XMarkIcon className="h-6 w-6 text-slate-600 transition group-hover:text-slate-400" />
                </button>
              </div>
              <div className="flex h-full w-full flex-col overflow-hidden bg-slate-800 p-5">
                <div className="grid grid-cols-[minmax(0,_1fr),_4rem,_minmax(0,_1fr)]">
                  <div className="flex h-full flex-col justify-between">
                    <Body className="mb-4 text-slate-400">
                      Add Trigger.dev to an existing Node.js repo.
                    </Body>
                    <PrimaryA
                      href="https://docs.trigger.dev/getting-started#manual-setup"
                      target="_blank"
                    >
                      Manual setup docs
                      <ArrowTopRightOnSquareIcon className="ml-1 h-4 w-4" />
                    </PrimaryA>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="h-full w-px bg-slate-700"></div>
                    <Body size="small" className="uppercase text-slate-600">
                      or
                    </Body>
                    <div className="h-full w-px bg-slate-700"></div>
                  </div>
                  <div className="flex h-full flex-col justify-between">
                    <Body className="mb-4 text-slate-400">
                      Setup a new Node.js project ready for Trigger.dev by
                      running this command.
                    </Body>
                    <CopyTextPanel
                      value={`npx create-trigger@latest --apiKey ${apiKey}`}
                      text={`npx create-trigger --apiKey ${apiKey}`}
                    />
                  </div>
                </div>
              </div>
            </StyledDialog.Panel>
          </div>
        </div>
      </StyledDialog.Dialog>

      <div className="mb-2 flex w-full items-center justify-between">
        <SubTitle className="mb-0">Get started with a template</SubTitle>
        <TertiaryButton onClick={(e) => setIsOpen(true)}>
          <InformationCircleIcon className="h-4 w-4" />
          Setup manually instead
        </TertiaryButton>
      </div>
      <div>
        <TemplatesGrid
          openInNewPage={false}
          templates={templates}
          commandFlags={`-k ${apiKey}`}
        />
      </div>
    </>
  );
}
