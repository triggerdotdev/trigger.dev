import { XCircleIcon } from "@heroicons/react/24/solid";
import { Fragment, useState } from "react";
import { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { StyledDialog } from "../primitives/Dialog";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";
import { TemplateOverview } from "./TemplateOverview";

export function TemplatesGrid({
  templates,
}: {
  templates: Array<TemplateListItem>;
}) {
  const [openedTemplate, setOpenedTemplate] = useState<TemplateListItem | null>(
    null
  );
  const isOpen = openedTemplate !== null;

  return (
    <>
      <StyledDialog.Dialog
        onClose={(e) => setOpenedTemplate(null)}
        appear
        show={isOpen}
        as={Fragment}
      >
        <StyledDialog.Panel className="relative mx-auto flex max-h-[80vh] max-w-5xl items-start gap-2 overflow-hidden overflow-y-auto rounded-md">
          {openedTemplate && <TemplateOverview template={openedTemplate} />}
          <button
            onClick={() => setOpenedTemplate(null)}
            className="sticky top-0 text-slate-600 transition hover:text-slate-500"
          >
            <XCircleIcon className="h-10 w-10" />
          </button>
        </StyledDialog.Panel>
      </StyledDialog.Dialog>
      <div className="mt-8 grid w-full grid-cols-1 items-start justify-start gap-4 md:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => {
          return (
            <button
              key={template.title}
              type="button"
              onClick={(e) => setOpenedTemplate(template)}
              className="group w-full flex flex-col h-full overflow-hidden rounded-md border border-slate-700 bg-slate-800 text-left text-sm text-slate-200 shadow-md transition hover:cursor-pointer hover:border-slate-500 hover:bg-slate-700/30 disabled:opacity-50"
            >
              <div className="h-24 w-full bg-slate-600 transition group-hover:opacity-90">
                <img
                  src={template.imageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="flex flex-col p-4">
                <div className="flex flex-row gap-x-1">
                  {template.services.map((service) => (
                    <div key={service.slug} className="">
                      <ApiLogoIcon
                        integration={service}
                        size="regular"
                        className="flex mb-2 h-8 w-8 items-center justify-center rounded border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-600 group-hover:bg-slate-900/80"
                      />
                    </div>
                  ))}
                </div>
                          <div className="flex flex-col gap-y-2 ">

                <Header1 size="small" className="font-semibold">
                  {template.title}
                </Header1>
                <Body size="small" className="text-slate-400">
                  {template.description}
                </Body>
              </div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}
