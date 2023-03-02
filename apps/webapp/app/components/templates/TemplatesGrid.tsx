import { XMarkIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Fragment, useState } from "react";
import type { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { CopyTextPanel } from "../CopyTextButton";
import { StyledDialog } from "../primitives/Dialog";
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
        <StyledDialog.Panel className="relative mx-auto flex max-h-[80vh] max-w-6xl items-start gap-2 overflow-hidden overflow-y-auto rounded-md border border-slate-700">
          {openedTemplate && (
            <TemplateOverview
              template={openedTemplate}
              commandFlags={commandFlags}
            />
          )}
          <button
            onClick={() => setOpenedTemplate(null)}
            className="group sticky top-2 -ml-[48px] rounded text-slate-400 transition hover:bg-slate-800/70 hover:text-slate-500"
          >
            <XMarkIcon className="h-8 w-8 transition group-hover:text-slate-300" />
          </button>
        </StyledDialog.Panel>
      </StyledDialog.Dialog>
      <div className="grid w-full grid-cols-1 items-start justify-start gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {templates.map((template) => {
          return (
            <TemplateButtonOrLink
              key={template.slug}
              template={template}
              openInNewPage={openInNewPage}
              onClick={() => setOpenedTemplate(template)}
              className="p-5"
            >
              <div className="w-full transition group-hover:opacity-90 group-hover:shadow-lg">
                <img
                  src={template.imageUrl}
                  alt={template.title}
                  className="h-full w-full rounded-md object-cover"
                />
              </div>
              <div className="flex h-full w-full flex-col justify-between">
                <Header1 size="regular" className="py-6 text-slate-100">
                  {template.title}
                </Header1>
                <CopyTextPanel
                  value={`npx create-trigger@latest ${template.slug}${
                    commandFlags ? ` ${commandFlags}` : ``
                  }`}
                  text={`npx create-trigger ${template.slug}`}
                  className=""
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
  className,
}: {
  template: TemplateListItem;
  openInNewPage: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const cardStyles =
    "group flex w-full p-5 flex-col self-stretch overflow-hidden rounded-md border border-slate-700/70 bg-slate-800 text-left text-slate-200 shadow-md transition hover:cursor-pointer hover:border-slate-600 hover:bg-slate-700/50 disabled:opacity-50";

  if (openInNewPage) {
    return (
      <Link
        to={template.slug}
        prefetch="intent"
        reloadDocument
        className={classNames(cardStyles, className)}
      >
        {children}
      </Link>
    );
  } else {
    return (
      <button
        key={template.title}
        type="button"
        onClick={onClick}
        className={cardStyles}
      >
        {children}
      </button>
    );
  }
}
