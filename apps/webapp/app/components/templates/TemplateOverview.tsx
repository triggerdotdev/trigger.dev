import { ArrowRightIcon } from "@heroicons/react/20/solid";
import classNames from "classnames";
import { Fragment } from "react";
import type { TemplateListItem } from "~/models/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { OctoKitty } from "../GitHubLoginButton";
import { TertiaryA, ToxicLink } from "../primitives/Buttons";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";

export function TemplateOverview({
  template,
  className,
}: {
  template: TemplateListItem;
  className?: string;
}) {
  const { docsHTML, imageUrl } = template;

  return (
    <div
      className={classNames(
        className,
        "grid w-full grid-cols-1 gap-8 rounded-lg bg-slate-850 pl-8 text-left md:grid-cols-[20rem_minmax(0,_1fr)]"
      )}
    >
      <div className="sticky top-4 flex h-max flex-col rounded-r">
        <TemplateDetails template={template} className="hidden md:flex" />
      </div>
      <div className="flex h-full w-full flex-col rounded">
        <div className="z-90 h-fit w-full transition group-hover:opacity-90">
          <img
            src={imageUrl}
            alt=""
            className="h-full w-full rounded-t object-cover"
          />
        </div>
        <TemplateDetails template={template} className="md:hidden" />
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
}: {
  className?: string;
  template: TemplateListItem;
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
          <div className="mb-4 flex gap-x-1">
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
          className="uppercase tracking-wide text-slate-500"
        >
          Repo
        </Body>
        <div className="ml-2 h-px w-full bg-slate-800" />
      </div>
      <TertiaryA href={repositoryUrl} target="_blank" className="mb-8">
        <OctoKitty className="h-4 w-4" />
        <Body size="small" className="truncate font-mono">
          {repositoryUrl.replace("https://github.com/triggerdotdev", "")}
        </Body>
      </TertiaryA>
      <ToxicLink
        size="large"
        className="group flex h-12 min-w-full"
        to={`../../templates/add?templateId=${id}`}
      >
        <span> Use this template </span>
        <ArrowRightIcon className="ml-1 h-5 w-5 transition group-hover:translate-x-0.5" />
      </ToxicLink>
    </div>
  );
}
