import { Header2 } from "../primitives/text/Headers";
import type { TemplateData } from "./TemplatesData";
import Slack from "../../../public/integrations/slack.png";
import { Body } from "../primitives/text/Body";
import { OctoKitty } from "../GitHubLoginButton";
import { PrimaryButton, TertiaryLink } from "../primitives/Buttons";
import { marked } from "marked";

export function TemplateOverview({ documentation, title, description, githubRepoURL, imageURL }: TemplateData) {
  return (
    <div className="flex h-full max-h-[500px] w-full overflow-scroll">
      <div className="flex w-full flex-col gap-y-2 rounded-l bg-slate-900">
        <div className="h-32 w-full bg-slate-600 transition group-hover:opacity-90">
          <img src={imageURL} alt="" className="h-full w-full object-cover" />
        </div>

        <div className="flex gap-y-2 p-4">
          {/* {documentation && (
            <div className="prose prose-sm prose-invert  p-4">
              <div
                dangerouslySetInnerHTML={{
                  __html: marked(documentation),
                }}
              />
            </div>
          )} */}
          <Body>
            Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do
            eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim
            ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut
            aliquip ex ea commodo consequat. Duis aute irure dolor in
            reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla
            pariatur. Excepteur sint occaecat cupidatat non proident, sunt in
            culpa qui officia deserunt mollit anim id est laborum.Lorem ipsum
            dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
            incididunt ut labore et dolore magna aliqua. Ut enim ad minim
            veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex
            ea commodo consequat. Duis aute irure dolor in reprehenderit in
            voluptate velit esse cillum dolore eu fugiat nulla pariatur.
            Excepteur sint occaecat cupidatat non proident, sunt in culpa qui
            officia deserunt mollit anim id est laborum.Lorem ipsum dolor sit
            amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt
            ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
            nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo
            consequat. Duis aute irure dolor in reprehenderit in voluptate velit
            esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat
            cupidatat non proident, sunt in culpa qui officia deserunt mollit
            anim id est laborum.
          </Body>
        </div>
      </div>
      <div className="sticky top-0 flex h-max w-[240px] min-w-[240px] flex-col gap-y-2 rounded-r bg-slate-700 p-4">
        <div
          key="integration"
          className="-lg mb-1 flex h-8 w-8 items-center justify-center rounded border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-800 group-hover:bg-slate-900"
        >
          <img src={Slack} alt="Slack" className="h-5 w-5" />
        </div>

        <Header2 size="regular" className="font-semibold">
          {title}
        </Header2>
        <Body>{description}</Body>

        <TertiaryLink to={""}>
          <OctoKitty className="h-4 w-4" />
          <Body className="font-mono ">{githubRepoURL}</Body>
        </TertiaryLink>

        <PrimaryButton className="mt-2 w-full">Use this template</PrimaryButton>
      </div>
    </div>
  );
}
