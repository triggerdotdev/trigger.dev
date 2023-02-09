import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";

export function TemplatesGrid() {
  return (
    <div className="grid grid-cols-3 gap-8 w-full flex-wrap mt-8">
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
      <TemplateCard />
    </div>
  );
}

function TemplateCard() {
  return (
    <div className=" group w-full items-center overflow-hidden rounded-md border border-slate-800 bg-slate-800 text-sm text-slate-200 shadow-md transition hover:bg-slate-800/30 disabled:opacity-50">
      <div className="group-hover:opacity-90 transition relative h-32 w-full bg-slate-600">
        <div className="absolute bottom-2 left-2">
          <div className="flex flex-row gap-x-2">
            <div className="group-hover:border-slate-700 h-12 w-12 rounded-lg border-[1px] border-slate-600 bg-slate-800 transition"></div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-y-1 p-4">
        <Header1 size="small" className="font-semibold">
          GitHub stars to Slack
        </Header1>
        <Body size="small" className="text-slate-400">
          When a GitHub repo is starred, post information about the user to
          Slack
        </Body>
      </div>
    </div>
  );
}
