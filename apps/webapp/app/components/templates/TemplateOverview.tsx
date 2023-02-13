import { Header2 } from "../primitives/text/Headers";
import type { TemplateData } from "./TemplatesData";
import Slack from "../../../public/integrations/slack.png";
import { Body } from "../primitives/text/Body";
import { OctoKitty } from "../GitHubLoginButton";
import { PrimaryButton, TertiaryLink } from "../primitives/Buttons";
import { marked } from "marked";

export function TemplateOverview({ documentation, title, description, githubRepoURL, imageURL }: TemplateData) {
  return (
    <div className="flex h-full w-full ">
      <div className="flex w-full flex-col gap-y-2 bg-slate-900 p-4">
        <div className="h-32 w-full bg-slate-600 transition group-hover:opacity-90">
          <img
            src={imageURL}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>

        {documentation && (
          <div
            className="prose prose-sm prose-invert"
            dangerouslySetInnerHTML={{
              __html: marked(documentation),
            }}
          />
        )}
      </div>
      <div className="-r flex w-[280px] min-w-[280px] flex-col gap-y-2 bg-slate-700 p-4">
        <div
          key="integration"
          className="-lg mb-1 flex h-8 w-8 items-center justify-center border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-800 group-hover:bg-slate-900"
        >
          <img src={Slack} alt="Slack" className="h-5 w-5" />
        </div>

        <Header2 size="regular" className="font-semibold">
          {title}
        </Header2>
        <div>{description}</div>

        <TertiaryLink to={""}>
          <OctoKitty className="h-4 w-4" />
          <Body className="font-mono ">{githubRepoURL}</Body>
        </TertiaryLink>

        <PrimaryButton className="mt-2 w-full">Use this template</PrimaryButton>
      </div>
    </div>
  );
}
