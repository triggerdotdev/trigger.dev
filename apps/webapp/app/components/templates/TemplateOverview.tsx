import { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { OctoKitty } from "../GitHubLoginButton";
import { PrimaryLink, TertiaryA } from "../primitives/Buttons";
import { Body } from "../primitives/text/Body";
import { Header2 } from "../primitives/text/Headers";

export function TemplateOverview({ template }: { template: TemplateListItem }) {
  const { docsHTML, title, description, repositoryUrl, imageUrl, id } =
    template;

  return (
    <div className="rounded-lg bg-slate-800 px-4 pb-4 text-left">
      <div className="z-90 sticky top-0 h-[200px] w-full border border-t-[20px] border-slate-800 transition group-hover:opacity-90">
        <img
          src={imageUrl}
          alt=""
          className="h-full w-full rounded object-cover"
        />
      </div>{" "}
      <div className="sticky top-[200px] h-[20px] w-full bg-gradient-to-b from-slate-800"></div>
      <div className="flex flex-row">
        <div className="flex h-full w-full flex-col gap-y-1 rounded ">
          <div className="flex rounded bg-slate-900/75 p-4">
            <div
              className="prose prose-sm prose-invert"
              dangerouslySetInnerHTML={{
                __html: docsHTML,
              }}
            />
          </div>
        </div>
        <div className="sticky top-[220px] ml-4 flex h-max w-[240px] min-w-[240px] flex-col rounded-r">
          <div className="flex flex-col gap-y-3 ">
            <PrimaryLink
              className="flex min-w-full"
              to={`../../templates/add?templateId=${id}`}
            >
              Use this template
            </PrimaryLink>
            <Header2 size="regular" className="font-semibold">
              {title}
            </Header2>
            <Body>{description}</Body>

            <div className="flex flex-row gap-x-1">
              {template.services.map((service) => (
                <div key={service.slug} className="">
                  <ApiLogoIcon
                    integration={service}
                    size="regular"
                    className="flex h-8 w-8 items-center justify-center rounded border-[1px] border-slate-700 bg-slate-900 transition group-hover:border-slate-600 group-hover:bg-slate-900/80"
                  />
                </div>
              ))}
            </div>

            <TertiaryA href={repositoryUrl} target="_blank">
              <OctoKitty className="h-4 w-4" />
              <Body size="extra-small" className="truncate font-mono">
                {repositoryUrl.replace("https://github.com/triggerdotdev", "")}
              </Body>
            </TertiaryA>
          </div>
        </div>
      </div>
    </div>
  );
}
