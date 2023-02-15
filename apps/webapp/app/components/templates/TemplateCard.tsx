import { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";

export function TemplateCard({ template }: { template: TemplateListItem }) {
  return (
    <button
      key={template.title}
      type="button"
      className="group flex h-full w-full flex-col overflow-hidden rounded-md border border-slate-700 bg-slate-800 text-left text-sm text-slate-200 shadow-md transition hover:cursor-pointer hover:border-slate-500 hover:bg-slate-700/30 disabled:opacity-50"
    >
      <div className="h-24 w-full bg-slate-600 transition group-hover:opacity-90">
        <img
          src={template.imageUrl}
          alt=""
          className="h-full w-full object-cover"
        />
      </div>
      <div className="flex flex-col p-4">
        <div className="flex flex-col gap-y-2 ">
          <Header1 size="small" className="font-semibold">
            {template.title}
          </Header1>
          <Body size="small" className="text-slate-400">
            {template.description}
          </Body>
        </div>
        <div className="flex flex-row gap-x-1">
          {template.services.map((service) => (
            <div key={service.slug} className="">
              <ApiLogoIcon
                integration={service}
                size="regular"
                className="mt-2 flex h-8 w-8 items-center justify-center rounded border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-600 group-hover:bg-slate-900/80"
              />
            </div>
          ))}
        </div>
      </div>
    </button>
  );
}
