import { XMarkIcon } from "@heroicons/react/24/solid";
import { Header2 } from "../primitives/text/Headers";
import { TemplateData } from "./TemplatesData";
import Slack from "../../../public/integrations/slack.png";
import { Body } from "../primitives/text/Body";
import { OctoKitty } from "../GitHubLoginButton";
import { PrimaryButton, TertiaryLink } from "../primitives/Buttons";


export function TemplateOverview() {
  return (
    <div className="flex h-full w-full rounded">
      <div className="flex w-full rounded-l bg-slate-900 p-4">
        <div className="h-80 w-10"></div>
        <div className="h-80 w-10"></div>
      </div>

      <div className="flex flex-col w-[280px] min-w-[280px] gap-y-2 rounded-r bg-slate-700 p-4">
        <div className="flex place-content-between">
          <div
            key="integration"
            className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-800 group-hover:bg-slate-900"
          >
            <img src={Slack} alt="Slack" className="h-5 w-5" />
          </div>
          <div className="group flex h-7 w-7 items-center justify-center justify-self-end rounded-full bg-slate-500/80 transition hover:cursor-pointer hover:bg-slate-400/80">
            <XMarkIcon className="group flex h-6 w-6 text-slate-800 transition group-hover:text-slate-900" />
          </div>
        </div>
        <Header2 size="regular" className="font-semibold">
          {TemplateData[0].title}
        </Header2>
        <div>{TemplateData[0].description}</div>

        <TertiaryLink to={""}>
          <OctoKitty className="h-4 w-4" />
          <Body className="font-mono ">{TemplateData[0].githubRepoURL}</Body>
        </TertiaryLink>

        <PrimaryButton className="mt-2 w-full">Use this template</PrimaryButton>
      </div>
    </div>
  );
}
