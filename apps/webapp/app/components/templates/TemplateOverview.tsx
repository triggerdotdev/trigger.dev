import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import classNames from "classnames";
import { Fragment } from "react";
import type { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { CopyTextPanel } from "../CopyTextButton";
import { SecondaryA } from "../primitives/Buttons";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";

export function TemplateOverview({
  template,
  className,
  commandFlags,
}: {
  template: TemplateListItem;
  className?: string;
  commandFlags?: string;
}) {
  const { docsHTML, imageUrl } = template;

  return (
    <div
      className={classNames(
        className,
        "grid w-full grid-cols-1 gap-8 rounded-lg bg-slate-850 pl-8 text-left lg:grid-cols-[24rem_minmax(0,_1fr)]"
      )}
    >
      <div className="flex h-max flex-col rounded-r lg:sticky lg:top-[5.5rem]">
        <TemplateDetails
          template={template}
          commandFlags={commandFlags}
          className="hidden lg:flex"
        />
      </div>
      <div className="flex h-full w-full flex-col rounded">
        <div className="hidden h-fit w-full transition group-hover:opacity-90 lg:block">
          <img
            src={imageUrl}
            alt="Template hero image"
            className="h-full w-full rounded-t-md object-cover"
          />
        </div>
        <TemplateDetails template={template} className="lg:hidden" />
        <div className="flex rounded-b bg-slate-900/75 p-8">
          <div
            className="prose prose-sm prose-invert min-w-full [&>pre]:bg-[rgb(17,23,41)]"
            dangerouslySetInnerHTML={{
              __html: docsHTML,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TemplateDetails({
  className,
  template,
  commandFlags,
}: {
  className?: string;
  template: TemplateListItem;
  commandFlags?: string;
}) {
  const { title, description, repositoryUrl, id } = template;
  return (
    <div className={classNames(className, "flex flex-col")}>
      <Header1 size="extra-large" className="mt-2 mb-4 font-semibold">
        {title}
      </Header1>
      <Body className="mb-6 text-slate-400">{description}</Body>
      {template.services.length != 0 ? (
        <>
          <div className="flex items-center">
            <Body
              size="extra-small"
              className="uppercase tracking-wide text-slate-500"
            >
              Integrations
            </Body>
            <div className="ml-2 h-px w-full bg-slate-800" />
          </div>
          <div className="mb-6 flex gap-x-1">
            {template.services.map((service) => (
              <Fragment key={service.service}>
                <ApiLogoIcon
                  integration={service}
                  size="regular"
                  className="mt-2 flex h-8 w-8 items-center justify-center rounded border border-slate-800 bg-slate-900 transition group-hover:border-slate-600 group-hover:bg-slate-900/80"
                />
              </Fragment>
            ))}
          </div>
        </>
      ) : (
        <></>
      )}
      <div className="mb-2 flex items-center">
        <Body
          size="extra-small"
          className="whitespace-nowrap uppercase tracking-wide text-slate-500"
        >
          Help and guides
        </Body>
        <div className="ml-2 h-px w-full bg-slate-800" />
      </div>
      <div className="mb-8 grid grid-cols-2 gap-2">
        <SecondaryA
          href={repositoryUrl}
          target="_blank"
          className="!max-w-full"
        >
          View Repo
          <ArrowTopRightOnSquareIcon className="ml-1 h-4 w-4" />
        </SecondaryA>
        <SecondaryA
          href="https://docs.trigger.dev"
          target="_blank"
          className="!max-w-full"
        >
          View Docs
          <ArrowTopRightOnSquareIcon className="ml-1 h-4 w-4" />
        </SecondaryA>
      </div>
      <div className="mb-2 flex items-center">
        <Body
          size="extra-small"
          className="whitespace-nowrap uppercase tracking-wide text-slate-500"
        >
          Get started
        </Body>
        <div className="ml-2 h-px w-full bg-slate-800" />
      </div>
      <Body className="mb-4 text-slate-400">
        Run this command in your terminal to create a new project using this
        template.
      </Body>
      <CopyTextPanel
        text={`npx create-trigger ${template.slug}`}
        value={`npx create-trigger@latest ${template.slug} ${
          commandFlags ? ` ${commandFlags}` : ""
        }`}
        className="mb-8"
      />
    </div>
  );
}
