import classNames from "classnames";
import type { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";

export function TemplateCard({
  template,
  className,
}: {
  template: TemplateListItem;
  className?: string;
}) {
  return (
    <div
      key={template.title}
      className={classNames(
        className,
        "flex h-fit w-full flex-col overflow-hidden rounded-md border border-slate-700/50 bg-slate-1000 text-slate-300 shadow-md"
      )}
    >
      <div className="h-36 w-full">
        <img
          src={template.imageUrl}
          alt={template.shortTitle}
          className="h-full w-full object-cover"
        />
      </div>
      <div className="flex flex-col p-5">
        <div className="flex flex-col gap-y-2 ">
          <Header1 size="extra-small" className="text-slate-300">
            {template.title}
          </Header1>
          <Body size="small" className="text-slate-500">
            {template.description}
          </Body>
        </div>
        <div className="flex flex-row gap-x-1">
          {template.services.map((service) => (
            <div key={service.service} className="">
              <ApiLogoIcon
                integration={service}
                size="regular"
                className="mt-2 flex h-8 w-8 items-center justify-center rounded border-[1px] border-slate-700 bg-slate-900"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
