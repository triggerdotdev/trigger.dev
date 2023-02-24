import { XCircleIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { Fragment, useState } from "react";
import type { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { CopyTextPanel } from "../CopyTextButton";
import { StyledDialog } from "../primitives/Dialog";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";
import { TemplateOverview } from "./TemplateOverview";

export function TemplatesGrid({
  templates,
  openInNewPage,
  commandFlags,
}: {
  templates: Array<TemplateListItem>;
  openInNewPage: boolean;
  commandFlags?: string;
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
          {openedTemplate && (
            <TemplateOverview
              template={openedTemplate}
              commandFlags={commandFlags}
            />
          )}
          <button
            onClick={() => setOpenedTemplate(null)}
            className="sticky top-0 text-slate-600 transition hover:text-slate-500"
          >
            <XCircleIcon className="h-10 w-10" />
          </button>
        </StyledDialog.Panel>
      </StyledDialog.Dialog>
      <div className="grid w-full grid-cols-1 items-start justify-start gap-4 md:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => {
          return (
            <TemplateButtonOrLink
              key={template.slug}
              template={template}
              openInNewPage={openInNewPage}
              onClick={() => setOpenedTemplate(template)}
            >
              <div className="w-full bg-slate-600 transition group-hover:opacity-90">
                <img
                  src={template.imageUrl}
                  alt={template.title}
                  className="h-32 w-full object-cover"
                />
              </div>
              <div className="flex h-full w-full flex-col justify-between p-5">
                <div className="flex flex-col gap-y-2">
                  <Header1 size="small" className="font-normal leading-6">
                    {template.title}
                  </Header1>
                  <Body size="small" className="text-slate-400">
                    {template.description}
                  </Body>
                </div>
                <CopyTextPanel
                  value={`npm create trigger@latest ${template.slug}${
                    commandFlags ? ` ${commandFlags}` : ``
                  }`}
                  text={`npm create trigger ${template.slug}`}
                  className="mt-5"
                />
              </div>
            </TemplateButtonOrLink>
          );
        })}
      </div>
    </>
  );
}

function TemplateButtonOrLink({
  template,
  openInNewPage,
  onClick,
  children,
}: {
  template: TemplateListItem;
  openInNewPage: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const classNames =
    "group flex w-full flex-col self-stretch overflow-hidden rounded-md border border-slate-700 bg-slate-800 text-left text-slate-200 shadow-md transition hover:cursor-pointer hover:border-slate-600 hover:bg-slate-700/50 disabled:opacity-50";

  if (openInNewPage) {
    return (
      <Link to={template.slug} className={classNames}>
        {children}
      </Link>
    );
  } else {
    return (
      <button
        key={template.title}
        type="button"
        onClick={onClick}
        className={classNames}
      >
        {children}
      </button>
    );
  }
}
