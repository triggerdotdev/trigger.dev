import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";
import Slack from "../../../public/integrations/slack.png";
import SlackTemplateBg from "../../../public/images/templates/slack-template.png";



export function TemplatesGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8 w-full flex-wrap mt-8">
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
    <div className=" group w-full items-center overflow-hidden rounded-md border border-slate-900 bg-slate-800 text-sm text-slate-200 shadow-md transition hover:cursor-pointer hover:bg-slate-800/30 disabled:opacity-50">
      <div className="relative h-36 w-full bg-slate-600 transition group-hover:opacity-90">
        <img
          src={SlackTemplateBg}
          alt="Slack-template"
          className="object-cover h-full w-auto group-hover:object-scale-down transition"
        />
        <div className="absolute bottom-2 left-2">
          <div className="flex flex-row gap-x-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg border-[1px] border-slate-600 bg-slate-800 transition group-hover:border-slate-700 group-hover:bg-slate-900">
              <img src={Slack} alt="Slack" className="h-8 w-8" />
            </div>
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
