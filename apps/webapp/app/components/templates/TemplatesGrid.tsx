import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";
import { templateData } from "./TemplatesData";
import Slack from "../../../public/integrations/slack.png";
import { Fragment, useState } from "react";
import { StyledDialog } from "../primitives/Dialog";
import { TemplateOverview } from "./TemplateOverview";
import { XCircleIcon } from "@heroicons/react/24/solid";

export function TemplatesGrid() {
  let [isOpen, setIsOpen] = useState(true);
  return (
    <>
      <StyledDialog.Dialog
        onClose={(e) => setIsOpen(false)}
        appear
        show={isOpen}
        as={Fragment}
      >
        <div className="fixed inset-0 overflow-y-auto ">
          <div className="flex min-h-full items-center justify-center p-4">
            <StyledDialog.Panel className="relative mx-auto max-w-5xl overflow-hidden rounded-md">
              <button
                onClick={() => setIsOpen(false)}
                className="absolute top-0 -right-12 text-slate-600 transition hover:text-slate-500"
              >
                <XCircleIcon className="h-10 w-10" />
              </button>
              <TemplateOverview {...templateData[0]} />
            </StyledDialog.Panel>
          </div>
        </div>
      </StyledDialog.Dialog>
      <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {templateData.map((template) => {
          return (
            <button
              key={template.title}
              type="button"
              onClick={(e) => setIsOpen(true)}
              className="group text-left w-full items-center overflow-hidden rounded-md border border-slate-700 bg-slate-800 text-sm text-slate-200 shadow-md transition hover:cursor-pointer hover:border-slate-700 hover:bg-slate-800/30 disabled:opacity-50"
            >
              <div className="h-24 w-full bg-slate-600 transition group-hover:opacity-90">
                <img
                  src={template.imageURL}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="flex flex-col gap-y-1 p-4">
                <div
                  key="integration"
                  className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-800 group-hover:bg-slate-900"
                >
                  <img src={Slack} alt="Slack" className="h-5 w-5" />
                </div>
                <Header1 size="small" className="font-semibold">
                  {template.title}
                </Header1>
                <Body size="small" className="text-slate-400">
                  {template.description}
                </Body>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}
