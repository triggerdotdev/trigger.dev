import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";
import { TemplateData } from "./TemplatesData";
import Slack from "../../../public/integrations/slack.png";


export function TemplatesGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 w-full flex-wrap mt-8">
      {TemplateData.map((template) => {
return (
  <div
    key={template.title}
    className=" group w-full items-center overflow-hidden rounded-md border border-slate-700 bg-slate-800 text-sm text-slate-200 shadow-md transition hover:cursor-pointer hover:border-slate-700 hover:bg-slate-800/30 disabled:opacity-50" 
  >
    <div className="relative h-32 bg-slate-600  transition group-hover:opacity-90">
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
  </div>
);
      })}
       </div>
  );
}
